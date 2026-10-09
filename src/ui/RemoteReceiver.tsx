import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { OpenWebRxClient } from "../remote/openWebRxClient";
import { KiwiClient, type KiwiSnapshot } from "../remote/kiwiClient";
import {
  defaultTune,
  REMOTE_MODES,
  type RemoteMode,
  type RemoteTune,
} from "../remote/openWebRxProtocol";
import { RemoteSpectrum } from "../remote/RemoteSpectrum";
import { RemotePresetsPanel, useRemotePresets } from "./RemotePresetsPanel";
import {
  validateRemotePreset,
  type RemotePreset,
  type RemoteKind,
} from "../remote/remotePresets";
function savedAddress(key: string) {
  try {
    return localStorage.getItem(key) ?? "";
  } catch {
    return "";
  }
}

export function RemoteReceiver({
  onStatus,
  initialPreset,
}: {
  onStatus: (status: string) => void;
  initialPreset?: RemotePreset;
}) {
  const [selection, setSelection] = useState<{
    kind: RemoteKind;
    preset?: RemotePreset;
    revision: number;
  }>(() => ({
    kind: initialPreset?.kind ?? "openwebrx",
    preset: initialPreset,
    revision: 0,
  }));
  const external = useRef(initialPreset);
  const library = useRemotePresets();
  useEffect(() => {
    if (initialPreset && initialPreset !== external.current) {
      external.current = initialPreset;
      setSelection((old) => ({
        kind: initialPreset.kind,
        preset: initialPreset,
        revision: old.revision + 1,
      }));
    }
  }, [initialPreset]);
  return (
    <RemoteReceiverView
      key={`${selection.kind}-${selection.revision}`}
      kind={selection.kind}
      onKind={(kind) =>
        setSelection((old) => ({ kind, revision: old.revision + 1 }))
      }
      onStatus={onStatus}
      loaded={selection.preset}
      library={library}
      onLoad={(value) => {
        const preset = validateRemotePreset(value);
        setSelection((old) => ({
          kind: preset.kind,
          preset,
          revision: old.revision + 1,
        }));
      }}
    />
  );
}

function RemoteReceiverView({
  kind,
  onKind,
  onStatus,
  loaded,
  library,
  onLoad,
}: {
  kind: "openwebrx" | "kiwi";
  onKind: (kind: "openwebrx" | "kiwi") => void;
  onStatus: (status: string) => void;
  loaded?: RemotePreset;
  library: ReturnType<typeof useRemotePresets>;
  onLoad: (preset: RemotePreset) => void;
}) {
  const [client] = useState(() =>
    kind === "kiwi" ? new KiwiClient() : new OpenWebRxClient(),
  );
  const addressKey = `browsersdr.${kind === "kiwi" ? "kiwisdr" : "openwebrx"}.address`;
  const state = useSyncExternalStore(client.subscribe, client.getSnapshot);
  const kiwiState = kind === "kiwi" ? (state as KiwiSnapshot) : undefined;
  const [address, setAddress] = useState(
    () => loaded?.address ?? savedAddress(addressKey),
  );
  const [draft, setDraft] = useState<RemoteTune>();
  const [frequency, setFrequency] = useState("");
  const [volume, setVolume] = useState(0.38);
  const [paused, setPaused] = useState(false);
  const [error, setError] = useState("");
  const [savedChannel, setSavedChannel] = useState(() =>
    loaded?.tune ? loaded : undefined,
  );
  const [applyingPreset, setApplyingPreset] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    input.current?.focus();
    return () => client.stop();
  }, [client]);
  useEffect(() => {
    onStatus(state.status);
  }, [onStatus, state.status]);
  useEffect(() => {
    if (!state.tune) return;
    setDraft(state.tune);
    setFrequency(String(state.tune.frequency / 1e6));
  }, [state.tune]);
  useEffect(() => {
    if (state.status === "connected") {
      try {
        localStorage.setItem(addressKey, state.website);
      } catch {
        /* Optional address preference. */
      }
    }
  }, [addressKey, state.status, state.website]);
  const connected =
    state.status === "connected" || state.status === "listening";
  const listening = state.status === "listening";
  const pending =
    state.status === "connecting" || Boolean(state.pendingProfile);
  const currentTune = () => {
    if (!draft || !frequency.trim())
      throw new Error("Enter a channel frequency.");
    const hz = Number(frequency) * 1e6;
    if (!Number.isFinite(hz))
      throw new Error("Enter a valid frequency in MHz.");
    return { ...draft, frequency: Math.round(hz) };
  };
  const apply = async () => {
    if (savedChannel || pending || !connected) return;
    setError("");
    try {
      const tune = currentTune();
      if (listening) client.tune(tune);
      else await client.start(tune, volume);
    } catch (reason) {
      setError((reason as Error).message);
    }
  };
  const modes = state.modes.length
    ? state.modes
    : (Object.keys(REMOTE_MODES) as RemoteMode[]);
  const finishPreset = (preset: RemotePreset) => {
    if (!preset.tune) return;
    client.validateTune(preset.tune);
    if (client instanceof KiwiClient && preset.zoom !== undefined) {
      if (preset.zoom > (kiwiState?.maxZoom ?? 0))
        throw new Error(
          "The saved zoom is unavailable on this receiver. Edit the preset or choose another receiver.",
        );
      client.setZoom(preset.zoom);
    }
    setDraft(preset.tune);
    setFrequency(String(preset.tune.frequency / 1e6));
    setSavedChannel(undefined);
    setApplyingPreset(false);
    setError("");
  };
  const preparePreset = () => {
    if (!savedChannel?.tune || state.status !== "connected" || pending) return;
    setError("");
    try {
      if (
        kind === "openwebrx" &&
        savedChannel.profile &&
        savedChannel.profile !== state.config?.profile
      ) {
        if (
          !state.profiles.some((profile) => profile.id === savedChannel.profile)
        )
          throw new Error(
            "The saved receiver band is unavailable. Edit the preset or choose another receiver.",
          );
        setApplyingPreset(true);
        client.selectProfile(savedChannel.profile);
      } else finishPreset(savedChannel);
    } catch (reason) {
      setApplyingPreset(false);
      setError((reason as Error).message);
    }
  };
  useEffect(() => {
    if (!applyingPreset || !savedChannel) return;
    if (state.status === "error" || state.status === "disconnected") {
      setApplyingPreset(false);
      return;
    }
    if (state.pendingProfile || state.config?.profile !== savedChannel.profile)
      return;
    try {
      finishPreset(savedChannel);
    } catch (reason) {
      setApplyingPreset(false);
      setError((reason as Error).message);
    }
    // Wait for this explicitly requested band's actual confirmation. Never Listen here.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    applyingPreset,
    savedChannel,
    state.config,
    state.pendingProfile,
    state.status,
  ]);
  return (
    <section className="remote-receiver" aria-labelledby="remote-heading">
      <div className="remote-heading">
        <div>
          <p className="eyebrow">Remote web receiver</p>
          <h2 id="remote-heading">
            {kind === "kiwi" ? "KiwiSDR" : "OpenWebRX"}
          </h2>
        </div>
        <div className="remote-protocol">
          <label>
            Receiver type
            <select
              aria-label="Remote receiver type"
              title="Changing receiver type disconnects the current remote stream"
              value={kind}
              onChange={(e) => onKind(e.currentTarget.value as typeof kind)}
            >
              <option value="openwebrx">OpenWebRX</option>
              <option value="kiwi">KiwiSDR</option>
            </select>
          </label>
          <a
            href="https://www.receiverbook.de/"
            target="_blank"
            rel="noopener noreferrer"
          >
            Find a receiver ↗
          </a>
        </div>
      </div>
      <div className="remote-connect-row">
        <label className="remote-address">
          Receiver website
          <input
            ref={input}
            type="url"
            value={address}
            disabled={connected || pending}
            placeholder="https://receiver.example/"
            onChange={(e) => setAddress(e.currentTarget.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !connected && !pending)
                client.connect(address);
            }}
          />
        </label>
        {!connected && !pending ? (
          <button
            type="button"
            onClick={() => {
              setError("");
              client.connect(address);
            }}
          >
            Connect
          </button>
        ) : (
          <button
            type="button"
            className="secondary"
            onClick={() => client.stop()}
          >
            {listening ? "Stop listening" : "Disconnect"}
          </button>
        )}
        {state.website && (
          <a href={state.website} target="_blank" rel="noopener noreferrer">
            Open receiver website ↗
          </a>
        )}
      </div>
      <p className="remote-message" role="status">
        {state.title && `${state.title} · `}
        {state.message}
      </p>
      {error && (
        <p role="alert" className="remote-error">
          {error}
        </p>
      )}
      {savedChannel && (
        <div className="remote-preset-review">
          <p>
            {loaded?.name} · {savedChannel.tune!.frequency / 1e6} MHz ·{" "}
            {REMOTE_MODES[savedChannel.tune!.mode]}. Connect, then apply this
            saved channel before Listen.
            {savedChannel.profile &&
              " Applying can select the saved receiver band."}
          </p>
          <button
            type="button"
            className="secondary"
            disabled={!connected || listening || pending || applyingPreset}
            onClick={preparePreset}
          >
            {applyingPreset ? "Waiting for saved band…" : "Apply saved channel"}
          </button>
          <button
            type="button"
            className="secondary"
            disabled={pending}
            onClick={() => {
              setSavedChannel(undefined);
              setApplyingPreset(false);
              setError("");
            }}
          >
            Use receiver defaults
          </button>
        </div>
      )}
      <div className="remote-channel-row">
        {kind === "openwebrx" ? (
          <label>
            Band
            <select
              aria-label="Remote band"
              disabled={!connected || listening || pending}
              value={state.pendingProfile || state.config?.profile || ""}
              onChange={(e) => {
                setError("");
                try {
                  client.selectProfile(e.currentTarget.value);
                } catch (reason) {
                  setError((reason as Error).message);
                }
              }}
            >
              <option value="" disabled>
                Receiver band
              </option>
              {state.config &&
                !state.profiles.some((p) => p.id === state.config?.profile) && (
                  <option value={state.config.profile}>Current band</option>
                )}
              {state.profiles.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </label>
        ) : (
          <label>
            Waterfall zoom
            <select
              aria-label="Waterfall zoom"
              disabled={!connected}
              value={kiwiState?.zoom ?? 0}
              onChange={(e) => {
                setError("");
                try {
                  if (client instanceof KiwiClient)
                    client.setZoom(Number(e.currentTarget.value));
                } catch (reason) {
                  setError((reason as Error).message);
                }
              }}
            >
              {Array.from(
                {
                  length: (kiwiState?.maxZoom ?? 0) + 1,
                },
                (_, zoom) => (
                  <option key={zoom} value={zoom}>
                    {zoom === 0 ? "Full band" : `${2 ** zoom}×`}
                  </option>
                ),
              )}
            </select>
          </label>
        )}
        <label>
          Channel · MHz
          <input
            aria-label="Remote channel MHz"
            inputMode="decimal"
            value={frequency}
            disabled={!connected || pending}
            onChange={(e) => setFrequency(e.currentTarget.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") void apply();
            }}
          />
        </label>
        <label>
          Mode
          <select
            aria-label="Remote mode"
            value={draft?.mode ?? "am"}
            disabled={!connected || pending}
            onChange={(e) => {
              if (!state.config || !draft) return;
              const tune = defaultTune(
                state.config,
                e.currentTarget.value as RemoteMode,
              );
              if (kind === "kiwi" && tune.mode === "nfm") {
                tune.lowCut = -Math.min(
                  5000,
                  Math.floor((kiwiState?.sampleRate ?? 12000) / 2),
                );
                tune.highCut = -tune.lowCut;
              }
              setDraft({ ...tune, frequency: draft.frequency });
            }}
          >
            {modes.map((mode) => (
              <option key={mode} value={mode}>
                {REMOTE_MODES[mode]}
              </option>
            ))}
          </select>
        </label>
        <button
          type="button"
          disabled={!connected || pending || Boolean(savedChannel)}
          onClick={() => void apply()}
        >
          {listening ? "Tune" : "Listen"}
        </button>
        <RemotePresetsPanel
          library={library}
          receiver={{ kind, address }}
          channel={
            connected && !pending && !savedChannel
              ? () => {
                  const tune = currentTune();
                  client.validateTune(tune);
                  return {
                    kind,
                    address: state.website,
                    tune,
                    ...(kind === "kiwi"
                      ? { zoom: kiwiState?.zoom ?? 0 }
                      : { profile: state.config?.profile }),
                  };
                }
              : undefined
          }
          onLoad={onLoad}
        />
        <label className="remote-volume">
          Volume
          <input
            type="range"
            min="0"
            max="100"
            value={Math.round(volume * 100)}
            onChange={(e) => {
              const value = Number(e.currentTarget.value) / 100;
              setVolume(value);
              client.volume(value);
            }}
          />
        </label>
        {listening && state.audioState !== "running" && (
          <button
            type="button"
            onClick={() => {
              void client
                .resume(volume)
                .catch((reason) => setError((reason as Error).message));
            }}
          >
            Resume audio
          </button>
        )}
      </div>
      <div className="remote-spectrum-panel">
        <div className="remote-spectrum-heading">
          <span>
            Server spectrum & waterfall · relative power
            {listening && state.tune && (
              <small className="remote-requested">
                Requested channel {(state.tune.frequency / 1e6).toFixed(6)} MHz
                · {REMOTE_MODES[state.tune.mode]}
              </small>
            )}
          </span>
          <button
            type="button"
            className="secondary"
            aria-pressed={paused}
            onClick={() => setPaused((p) => !p)}
          >
            {paused ? "Resume display" : "Pause display"}
          </button>
        </div>
        <RemoteSpectrum client={client} config={state.config} paused={paused} />
      </div>
      <div className="remote-footer">
        <p>
          {kind === "kiwi" &&
            "Connect reserves a receiver channel and receives server data; browser audio stays off until Listen. "}
          Audio and spectrum are processed by this remote receiver. Raw I/Q
          recording, local decoders, Explorer, local Favorites and live session
          sharing apply to local sources. Returning to the local workspace
          disconnects this stream.
        </p>
        <details>
          <summary>Stream details & filters</summary>
          <p>
            {state.version || "Version not received"} ·{" "}
            {state.fftFrames.toLocaleString()} spectrum frames ·{" "}
            {state.audioSamples.toLocaleString()} audio samples · audio{" "}
            {state.audioState} · {state.audioDrops} audio drops/resets
          </p>
          {state.config && (
            <p>
              Receiver {(state.config.center / 1e6).toFixed(6)} MHz ·{" "}
              {(state.config.rate / 1e6).toFixed(3)} MHz span ·{" "}
              {state.config.fftSize} bins · audio{" "}
              {state.config.audioCompression}, spectrum{" "}
              {state.config.fftCompression}.{" "}
              {kind === "kiwi"
                ? `${kiwiState?.sampleRate.toFixed(3) ?? ""} samples/s server audio; ${kiwiState?.packetDiscontinuities ?? 0} audio packet discontinuities.`
                : "Band selection can change a shared receiver; use its website for access rules."}
            </p>
          )}
          <div className="remote-filters">
            {(["lowCut", "highCut", "squelch"] as const)
              .filter((key) => kind !== "kiwi" || key !== "squelch")
              .map((key) => (
                <label key={key}>
                  {key === "lowCut"
                    ? "Low cut · Hz"
                    : key === "highCut"
                      ? "High cut · Hz"
                      : "Squelch · relative dB"}
                  <input
                    type="number"
                    value={draft?.[key] ?? ""}
                    disabled={!connected || pending}
                    onChange={(e) => {
                      if (draft)
                        setDraft({
                          ...draft,
                          [key]: Number(e.currentTarget.value),
                        });
                    }}
                  />
                </label>
              ))}
          </div>
          <p>
            CW uses a 700 Hz beat tone; CW filter edges are relative to that
            oscillator. Filter and mode changes take effect with Listen or Tune.
            Tuning is requested, without a hardware acknowledgement or
            transmitter identity claim.
          </p>
        </details>
      </div>
    </section>
  );
}

import { InstrumentRange } from "./InstrumentRange";
import { InstrumentButton } from "./InstrumentButton";
import {
  useEffect,
  useRef,
  useState,
  type Dispatch,
  type SetStateAction,
} from "react";
import { createPortal } from "react-dom";
import type { AnalysisPipeline } from "../dsp/analysisPipeline";
import type { InputLevel } from "../dsp/inputClipping";
import type {
  ReceiverController,
  ReceiverSnapshot,
} from "../radio/receiverController";
import type { RtlInputSettings } from "../radio/rtlInput";
import type { Bookmark } from "../radio/bookmarks";
import type { HackrfRxSettings } from "../radio/sourceCapabilities";
import type { SourceKind } from "../radio/types";
import type { IqRecording } from "../radio/iqRecording";
import type { SecondaryVfoSettings } from "../radio/secondaryVfo";
import { runGainSetup } from "../radio/gainSetup";
import {
  runChannelWatch,
  type WatchChannel,
  type WatchEvent,
} from "../radio/channelWatch";
import { ActivityCapture } from "../radio/activityCapture";
import { defaultModeSettings } from "../radio/receiverConfig";
import "./ReceiverExpansionPanel.css";
import { WorkspaceToolDialog } from "./WorkspaceToolDialog";
import { useVisibleReceiver } from "./useVisibleReceiver";

export default function ReceiverExpansionPanel({
  active,
  vfoTarget,
  watchTarget,
  controller,
  pipeline,
  receiver,
  source,
  input,
  onInput,
  hardware,
  onHardware,
  favorites,
  volume,
  blocked,
  onOperationChange,
  recordings,
  onRecordings: setRecordings,
}: {
  active: boolean;
  vfoTarget: HTMLElement | null;
  watchTarget: HTMLElement | null;
  controller: ReceiverController;
  pipeline: AnalysisPipeline;
  receiver: ReceiverSnapshot;
  source: SourceKind;
  input: RtlInputSettings;
  onInput: (input: RtlInputSettings) => void;
  hardware: HackrfRxSettings;
  onHardware: (value: HackrfRxSettings) => Promise<void>;
  favorites: Bookmark[];
  volume: number;
  blocked: boolean;
  onOperationChange: (active: boolean) => void;
  recordings: IqRecording[];
  onRecordings: Dispatch<SetStateAction<IqRecording[]>>;
}) {
  const currentVolume = useRef(volume);
  useEffect(() => {
    currentVolume.current = volume;
  }, [volume]);
  const [level, setLevel] = useState<InputLevel>();
  const [healthOpen, setHealthOpen] = useState(false);
  const [inputOpen, setInputOpen] = useState(false);
  // App intentionally ignores passive decoder-only publications. Subscribe at
  // this presentation boundary, just like the dock, while health is visible.
  const { receiver: healthReceiver } = useVisibleReceiver(
    controller,
    active && healthOpen,
  );
  const [message, setMessage] = useState("");
  const [messageLocation, setMessageLocation] = useState<
    "acquire" | "tune" | "watch"
  >("acquire");
  const [operation, setOperation] = useState<"gain" | "watch">();
  const abort = useRef<AbortController>(undefined);
  const [continuous, setContinuous] = useState(false);
  const [vfo, setVfo] = useState<SecondaryVfoSettings>({
    frequencyHz: receiver.session?.selectedChannelFrequencyHz ?? 100_000_000,
    mode: "NBFM",
    bandwidthHz: 12_500,
    squelch: 0,
    volume: 0.3,
    muted: false,
    recordAudio: false,
  });
  const [targets, setTargets] = useState("");
  const [favoriteTargets, setFavoriteTargets] = useState<WatchChannel[]>();
  const [dwell, setDwell] = useState(1000),
    [hold, setHold] = useState(2000),
    [threshold, setThreshold] = useState(12),
    [cooldown, setCooldown] = useState(30_000);
  const [listen, setListen] = useState(true),
    [capture, setCapture] = useState(false),
    [pre, setPre] = useState(0.5),
    [post, setPost] = useState(2);
  const [events, setEvents] = useState<WatchEvent[]>([]);
  const busy = !active || Boolean(operation) || blocked,
    running = receiver.lifecycle === "running";
  const local = ["rtl-sdr", "hackrf", "bladerf", "usrp-b205"].includes(source);
  const rawSupported = ["rtl-sdr", "hackrf"].includes(source);
  useEffect(() => {
    const tracking =
      active && running && rawSupported && (healthOpen || operation === "gain");
    pipeline.setInputLevelEnabled(tracking);
    if (!tracking) {
      setLevel(undefined);
      return;
    }
    const refresh = () => setLevel(pipeline.getInputLevel());
    refresh();
    const timer = setInterval(refresh, 500);
    return () => {
      clearInterval(timer);
      pipeline.setInputLevelEnabled(false);
    };
  }, [pipeline, active, running, rawSupported, healthOpen, operation]);
  useEffect(() => {
    setHealthOpen(false);
    setInputOpen(false);
    setLevel(undefined);
  }, [source, active]);
  const changeHealthOpen = (open: boolean) => {
    if (!open && operation === "gain") abort.current?.abort();
    if (!open) setLevel(undefined);
    setHealthOpen(open);
  };
  const acceptedInput = receiver.session?.rtlInput;
  const shownInput = acceptedInput ?? input;
  const inputLabel = (value: RtlInputSettings) =>
    `${value.directSampling === "q" ? "Direct sampling · Q branch" : "Normal tuner"}${value.converterOffsetHz ? ` · Converter ${value.converterOffsetHz > 0 ? "+" : ""}${value.converterOffsetHz.toLocaleString()} Hz` : ""} · ${value.profile === "always-on-bias" ? "Power always on (hardware)" : ["rtl-blog-v3", "rtl-blog-v4"].includes(value.profile) ? (value.biasTee ? "Power on (acknowledged)" : "Power off") : "Power unavailable"}`;
  const inputPending = Boolean(
    acceptedInput && JSON.stringify(acceptedInput) !== JSON.stringify(input),
  );
  const operationCallback = useRef(onOperationChange);
  useEffect(() => {
    operationCallback.current = onOperationChange;
  }, [onOperationChange]);
  useEffect(() => {
    const cancel = () => abort.current?.abort();
    window.addEventListener("pagehide", cancel);
    document.addEventListener("freeze", cancel);
    return () => {
      cancel();
      operationCallback.current(false);
      window.removeEventListener("pagehide", cancel);
      document.removeEventListener("freeze", cancel);
    };
  }, []);
  useEffect(() => {
    abort.current?.abort();
  }, [source]);
  useEffect(() => {
    if (!active) abort.current?.abort();
  }, [active]);
  const execute = async (
    kind: "gain" | "watch",
    run: (signal: AbortSignal) => Promise<void>,
  ) => {
    if (busy) return;
    const token = new AbortController();
    abort.current = token;
    setOperation(kind);
    setMessageLocation(kind === "gain" ? "acquire" : "watch");
    setMessage("");
    onOperationChange(true);
    try {
      await run(token.signal);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      if (abort.current === token) {
        abort.current = undefined;
        setOperation(undefined);
        onOperationChange(false);
      }
    }
  };
  const startWatch = () =>
    void execute("watch", async (signal) => {
      const channels: WatchChannel[] =
        favoriteTargets ??
        targets
          .split(/[\n,;]+/)
          .filter((text) => text.trim())
          .map((text) => {
            const frequencyHz = Math.round(Number(text.trim()) * 1e6);
            return {
              name: text.trim() + " MHz",
              frequencyHz,
              settings: defaultModeSettings("NBFM"),
            };
          });
      if (!channels.length)
        throw new Error(
          "Enter frequencies in MHz or add compatible Favorites.",
        );
      const buffer = capture
        ? new ActivityCapture(pre, post, (recording) =>
            setRecordings((old) => [...old, recording].slice(-3)),
          )
        : undefined;
      await runChannelWatch({
        controller,
        pipeline,
        channels,
        settings: {
          dwellMs: dwell,
          holdMs: hold,
          thresholdDb: threshold,
          cooldownMs: cooldown,
          listen,
        },
        signal,
        volume,
        getVolume: () => currentVolume.current,
        onVisit: setMessage,
        onEvent: (event) => setEvents((old) => [event, ...old].slice(0, 64)),
        capture: buffer,
      });
    });
  const downloadCapture = async (recording: IqRecording) => {
    setMessageLocation("watch");
    try {
      const exporter = await import("../radio/recordingExportFormat");
      const prepared = await exporter.prepareRecordingExport(
        recording,
        "sigmf",
      );
      exporter.triggerFileDownload(exporter.createRecordingArchive(prepared));
      setMessage(
        "Event capture ZIP download requested. Keep this tab until the file is saved.",
      );
    } catch (error) {
      setMessage(String(error));
    }
  };
  return (
    <div className="receiver-expansion receiver-tools">
      <WorkspaceToolDialog
        title="Reception health"
        icon="activity"
        open={healthOpen}
        onOpenChange={changeHealthOpen}
        summary={
          !rawSupported
            ? "Decoder checks · Raw levels unavailable"
            : !running
              ? "Not measured · Receiver stopped"
              : "Receiving · Open diagnostics"
        }
        footer={
          operation === "gain"
            ? "Closing cancels guided gain setup."
            : "Relative input levels · not calibrated RF power or SNR"
        }
      >
        <div className="receiver-tools health-content">
          <section>
            <h4>Raw input</h4>
            <p role="status">
              {!rawSupported
                ? "Raw input levels unavailable for this source"
                : !running
                  ? "Not measured · Receiver stopped"
                  : !level
                    ? "Waiting for fresh raw input measurements"
                    : "Fresh sampled input"}
            </p>
            <dl className="health-metrics">
              <div>
                <dt>RMS level</dt>
                <dd>
                  {rawSupported && running && level
                    ? `${level.rmsDb.toFixed(1)} dB relative`
                    : "—"}
                </dd>
              </div>
              <div>
                <dt>Peak level</dt>
                <dd>
                  {rawSupported && running && level
                    ? `${level.peakDb.toFixed(1)} dB relative`
                    : "—"}
                </dd>
              </div>
              <div>
                <dt>Clipping</dt>
                <dd>
                  {rawSupported && running && level
                    ? `${(level.clippedFraction * 100).toFixed(2)}%`
                    : "—"}
                </dd>
              </div>
              <div>
                <dt>DC offset</dt>
                <dd>
                  {rawSupported && running && level ? level.dc.toFixed(3) : "—"}
                </dd>
              </div>
            </dl>
            <p>
              {!rawSupported
                ? "Raw input headroom requires RTL-SDR or HackRF live I/Q. Use the decoder integrity checks for this source."
                : !running
                  ? "Start RTL/HackRF reception to measure raw input headroom."
                  : !level
                    ? "No fresh raw level. Check USB delivery and receiver status."
                    : level.clippedFraction >= 0.001
                      ? "Reduce gain or disable the RF amplifier. Strong nearby signals can overload reception."
                      : level.rmsDb < -35
                        ? "Low total input level. Check the antenna/band and expected signal; quiet intervals are normal for packets."
                        : "Input has headroom. If decoding fails, check frequency, rate, bandwidth and decoder lock."}
            </p>
            <small>
              Relative sampled levels describe the captured bandwidth, not
              calibrated RF power or selected-signal SNR.
            </small>
          </section>
          <section>
            <h4>Guided gain</h4>
            <label className="receiver-auto-center receiver-tool-toggle">
              <input
                type="checkbox"
                checked={continuous}
                disabled={busy}
                onChange={(e) => setContinuous(e.currentTarget.checked)}
              />
              <span className="receiver-switch-track" aria-hidden="true" />I am
              using a continuous signal for gain setup
            </label>
            <InstrumentButton
              disabled={
                busy ||
                !running ||
                !continuous ||
                !["rtl-sdr", "hackrf"].includes(source) ||
                receiver.session?.rtlInput?.directSampling === "q"
              }
              onClick={() =>
                void execute("gain", (signal) =>
                  runGainSetup(
                    controller,
                    () => pipeline.getInputLevel(),
                    signal,
                    setMessage,
                  ),
                )
              }
            >
              Set input headroom
            </InstrumentButton>
            {operation === "gain" && (
              <InstrumentButton onClick={() => abort.current?.abort()}>
                Cancel gain setup
              </InstrumentButton>
            )}
          </section>
          <section>
            <h4>Decoder checks</h4>
            {healthReceiver.session?.mode === "WBFM" && (
              <>
                <p role="status">
                  {healthReceiver.rds?.validGroups
                    ? `${healthReceiver.rds.validGroups.toLocaleString()} validated RDS groups this session`
                    : "No checked RDS groups yet. Verify tuning and manual gain."}
                </p>
                <p>Pilot/stereo detection does not guarantee RDS.</p>
              </>
            )}
            {healthReceiver.session?.mode === "DAB" && (
              <p>
                {healthReceiver.dab?.state !== "synchronized"
                  ? "DAB has no current synchronization. Check ensemble center, full-band sample rate, antenna placement and gain."
                  : !healthReceiver.dab?.ficBlockCount
                    ? "DAB timing is present but valid service information is missing."
                    : healthReceiver.dab?.audioDecoderState === "error"
                      ? `DAB service decoding error: ${healthReceiver.dab.audioDecoderMessage ?? "inspect programme/codec status"}`
                      : "Valid DAB service information is available. Service metadata alone does not establish audible audio."}
              </p>
            )}
            {!["WBFM", "DAB"].includes(healthReceiver.session?.mode ?? "") && (
              <p>
                Check the selected decoder and its integrity results in Audio
                &amp; decode.
              </p>
            )}
          </section>
          {messageLocation === "acquire" && message && (
            <p role="status">{message}</p>
          )}
        </div>
      </WorkspaceToolDialog>
      {source === "rtl-sdr" && (
        <WorkspaceToolDialog
          title="RF input & power"
          icon="sliders"
          open={inputOpen}
          onOpenChange={setInputOpen}
          summary={`${acceptedInput ? "Active: " : "Next connection: "}${inputLabel(shownInput)}${inputPending ? " · Pending changes" : ""}`}
          footer={
            inputPending
              ? "Pending input changes apply on the next explicit Start/connection."
              : "Input changes require stopped reception."
          }
        >
          <section>
            <h4>Board profile</h4>
            <p>
              Tuner: {receiver.session?.rtlTuner ?? "Unknown"}. Choose the
              actual board; tuner detection does not identify it.
            </p>
            <label>
              Declared RTL board
              <select
                aria-label="Declared RTL board"
                disabled={busy || running}
                value={input.profile}
                onChange={(e) =>
                  onInput({
                    ...input,
                    profile: e.currentTarget
                      .value as RtlInputSettings["profile"],
                    directSampling: "off",
                    biasTee: false,
                  })
                }
              >
                <option value="generic">Generic / unknown</option>
                <option value="nesdr-smart-v5">Nooelec NESDR SMArt v5</option>
                <option value="rtl-blog-v3">RTL-SDR Blog V3</option>
                <option value="rtl-blog-v4">RTL-SDR Blog V4</option>
                <option value="always-on-bias">
                  Always-on hardware bias tee
                </option>
              </select>
            </label>
          </section>
          <section>
            <h4>Input path &amp; converter</h4>
            <label>
              HF input
              <select
                aria-label="HF input"
                value={input.directSampling}
                disabled={
                  busy ||
                  running ||
                  !["nesdr-smart-v5", "rtl-blog-v3"].includes(input.profile)
                }
                onChange={(e) =>
                  onInput({
                    ...input,
                    directSampling: e.currentTarget.value as "off" | "q",
                    converterOffsetHz: 0,
                  })
                }
              >
                <option value="off">Normal tuner</option>
                <option value="q">Direct sampling · Q branch</option>
              </select>
            </label>
            <label>
              Converter offset (Hz)
              <input
                aria-label="Converter offset (Hz)"
                type="number"
                step="1"
                min="-1000000000"
                max="1000000000"
                value={input.converterOffsetHz}
                disabled={busy || running || input.directSampling === "q"}
                onChange={(e) =>
                  onInput({
                    ...input,
                    converterOffsetHz: e.currentTarget.valueAsNumber,
                  })
                }
              />
            </label>
            <small>
              Device frequency = antenna RF + offset. Example: a 125 MHz
              upconverter uses +125000000. Stop before changing input; settings
              apply on Start. Q branch covers 0.1–24 MHz in this profile and can
              receive aliases; use a suitable HF antenna/filter.
            </small>
          </section>
          <section>
            <h4>Antenna power</h4>
            {["rtl-blog-v3", "rtl-blog-v4"].includes(input.profile) ? (
              <label className="receiver-auto-center receiver-tool-toggle">
                <input
                  aria-label="RTL bias tee"
                  type="checkbox"
                  disabled={busy || running}
                  checked={input.biasTee}
                  onChange={(e) =>
                    onInput({ ...input, biasTee: e.currentTarget.checked })
                  }
                />
                <span className="receiver-switch-track" aria-hidden="true" />
                Enable antenna power for this connection · 4.5 V, up to 180 mA
              </label>
            ) : (
              <p>
                {input.profile === "always-on-bias"
                  ? "Always-on hardware power cannot be disabled by software."
                  : "Switchable antenna power is unavailable for this declared board."}
              </p>
            )}
            <small>
              Use only with a compatible powered antenna/LNA. Acknowledged
              settings do not measure connector voltage. Power is never restored
              from saved preferences.
            </small>
          </section>
        </WorkspaceToolDialog>
      )}
      {source === "hackrf" && (
        <WorkspaceToolDialog
          title="RF input & power"
          icon="sliders"
          open={inputOpen}
          onOpenChange={setInputOpen}
          summary={
            receiver.session?.hackrf
              ? `Antenna power ${receiver.session.hackrf.captureSettings.antennaPowerEnabled ? "on (acknowledged)" : "off"}`
              : "Antenna power · Connect first"
          }
        >
          <section>
            <h4>Antenna power</h4>
            <label className="receiver-auto-center receiver-tool-toggle">
              <input
                type="checkbox"
                aria-label="HackRF antenna power"
                disabled={busy || !receiver.session?.hackrf}
                checked={hardware.antennaPowerEnabled}
                onChange={(e) =>
                  void onHardware({
                    ...hardware,
                    antennaPowerEnabled: e.currentTarget.checked,
                  }).catch((error) => setMessage(String(error)))
                }
              />
              <span className="receiver-switch-track" aria-hidden="true" />
              Enable 3.3 V antenna power · up to 50 mA
            </label>
            <small>
              For a compatible powered antenna/LNA. Separate from RF amplifier
              gain; accepted command, not measured voltage. Default off on a new
              connection.
            </small>
          </section>
        </WorkspaceToolDialog>
      )}
      {local &&
        vfoTarget &&
        createPortal(
          <div className="receiver-vfo-tools receiver-tools">
            <details>
              <summary>
                <span>Second audio channel · VFO B</span>
                <small>
                  {receiver.secondaryVfo
                    ? `${(receiver.secondaryVfo.frequencyHz / 1e6).toFixed(3)} MHz · ${receiver.secondaryVfo.mode}`
                    : "Off"}
                </small>
              </summary>
              <label>
                VFO B frequency (MHz)
                <input
                  aria-label="VFO B frequency (MHz)"
                  type="number"
                  step="0.000001"
                  value={vfo.frequencyHz / 1e6}
                  disabled={busy}
                  onChange={(e) =>
                    setVfo({
                      ...vfo,
                      frequencyHz: Math.round(
                        e.currentTarget.valueAsNumber * 1e6,
                      ),
                    })
                  }
                />
              </label>
              <InstrumentButton
                className="secondary"
                disabled={busy || !receiver.session}
                onClick={() =>
                  setVfo({
                    ...vfo,
                    frequencyHz: receiver.session!.selectedChannelFrequencyHz,
                  })
                }
              >
                Copy VFO A frequency
              </InstrumentButton>
              <label>
                VFO B mode
                <select
                  aria-label="VFO B mode"
                  disabled={busy}
                  value={vfo.mode}
                  onChange={(e) => {
                    const mode = e.currentTarget
                      .value as SecondaryVfoSettings["mode"];
                    setVfo({
                      ...vfo,
                      mode,
                      bandwidthHz: defaultModeSettings(mode).bandwidthHz,
                    });
                  }}
                >
                  {["AM", "NBFM", "USB", "LSB", "CW"].map((mode) => (
                    <option key={mode}>{mode}</option>
                  ))}
                </select>
              </label>
              <label>
                VFO B bandwidth (Hz)
                <input
                  type="number"
                  min="100"
                  max="30000"
                  value={vfo.bandwidthHz}
                  disabled={busy}
                  onChange={(e) =>
                    setVfo({
                      ...vfo,
                      bandwidthHz: e.currentTarget.valueAsNumber,
                    })
                  }
                />
              </label>
              <label>
                VFO B squelch
                <input
                  type="number"
                  min="0"
                  max="6"
                  step="0.1"
                  value={vfo.squelch}
                  disabled={busy}
                  onChange={(e) =>
                    setVfo({ ...vfo, squelch: e.currentTarget.valueAsNumber })
                  }
                />
              </label>
              <label>
                VFO B volume
                <InstrumentRange
                  aria-label="VFO B volume"

                  min="0"
                  max="1"
                  step="0.05"
                  value={vfo.volume}
                  disabled={busy}
                  onChange={(e) =>
                    setVfo({ ...vfo, volume: e.currentTarget.valueAsNumber })
                  }
                />
              </label>
              <label className="receiver-auto-center receiver-tool-toggle">
                <input
                  type="checkbox"
                  checked={vfo.muted}
                  disabled={busy}
                  onChange={(e) =>
                    setVfo({ ...vfo, muted: e.currentTarget.checked })
                  }
                />
                <span className="receiver-switch-track" aria-hidden="true" />
                Mute VFO B
              </label>
              <label className="receiver-auto-center receiver-tool-toggle">
                <input
                  type="checkbox"
                  checked={vfo.recordAudio}
                  disabled={busy}
                  onChange={(e) =>
                    setVfo({ ...vfo, recordAudio: e.currentTarget.checked })
                  }
                />
                <span className="receiver-switch-track" aria-hidden="true" />
                Use VFO B for audio WAV/rewind
              </label>
              <InstrumentButton
                disabled={busy || !running}
                onClick={() =>
                  void controller.configureSecondaryVfo(vfo).catch((error) => {
                    setMessageLocation("tune");
                    setMessage(String(error));
                  })
                }
              >
                {receiver.secondaryVfo ? "Apply VFO B" : "Enable VFO B"}
              </InstrumentButton>
              <InstrumentButton
                className="secondary"
                disabled={busy || !running || !receiver.secondaryVfo}
                onClick={() =>
                  void controller.configureSecondaryVfo().catch((error) => {
                    setMessageLocation("tune");
                    setMessage(String(error));
                  })
                }
              >
                Disable VFO B
              </InstrumentButton>
              <p>
                {receiver.secondaryVfo
                  ? `VFO B receiving ${(receiver.secondaryVfo.frequencyHz / 1e6).toFixed(6)} MHz · ${receiver.secondaryVfo.mode}`
                  : (receiver.secondaryVfoMessage ?? "VFO B off")}
              </p>
              <small>
                Both channels share one RF window and hardware gains. VFO B
                never retunes hardware. VFO A volume remains in Audio; Select
                VFO A or B in I/Q recording controls; both use the original
                shared acquisition. Sharing publishes VFO A audio.
              </small>
            </details>
            {messageLocation === "tune" && message && (
              <p role="status">{message}</p>
            )}
          </div>,
          vfoTarget,
        )}
      {watchTarget &&
        createPortal(
          <div className="receiver-watch-tools receiver-tools">
            <section aria-label="Watch channels">
              <header className="watch-heading">
                <h2>Watch channels</h2>
                <p>
                  Listen to a channel list, review activity alerts and retain
                  event captures.
                </p>
                <div className="watch-actions">
                  <InstrumentButton
                    disabled={
                      busy ||
                      !local ||
                      !running ||
                      Boolean(receiver.secondaryVfo) ||
                      (capture && recordings.length > 0)
                    }
                    onClick={startWatch}
                  >
                    Start watching
                  </InstrumentButton>
                  {operation === "watch" && (
                    <InstrumentButton onClick={() => abort.current?.abort()}>
                      Stop watching
                    </InstrumentButton>
                  )}
                </div>
              </header>
              {!local && (
                <p>
                  Choose a local RTL-SDR, HackRF, bladeRF or USRP receiver to
                  start watching. Retained event captures remain available here.
                </p>
              )}
              <div className="watch-settings-grid">
                <label>
                  Watch frequencies (MHz)
                  <textarea
                    aria-label="Watch frequencies (MHz)"
                    value={targets}
                    disabled={busy}
                    onChange={(e) => {
                      setTargets(e.currentTarget.value);
                      setFavoriteTargets(undefined);
                    }}
                    placeholder="145.500, 145.550"
                  />
                </label>
                <InstrumentButton
                  className="secondary"
                  disabled={busy}
                  onClick={() => {
                    const selected = favorites
                      .filter((f) =>
                        ["AM", "NBFM", "USB", "LSB", "CW", "WBFM"].includes(
                          f.settings.mode,
                        ),
                      )
                      .slice(0, 64);
                    setFavoriteTargets(
                      selected.map((f) => ({
                        name: f.name,
                        frequencyHz: f.frequencyHz,
                        settings: structuredClone(f.settings),
                      })),
                    );
                    setTargets(
                      selected
                        .map((f) => String(f.frequencyHz / 1e6))
                        .join("\n"),
                    );
                  }}
                >
                  Use Favorites frequencies
                </InstrumentButton>
                <small>
                  Entered frequencies use NBFM; Favorites retain their saved
                  mode and settings. Watching revisits channels sequentially;
                  gaps are unobserved. Disable VFO B before starting.
                </small>
                <label>
                  Dwell (ms)
                  <input
                    type="number"
                    min="250"
                    max="30000"
                    value={dwell}
                    disabled={busy}
                    onChange={(e) => setDwell(e.currentTarget.valueAsNumber)}
                  />
                </label>
                <label>
                  Maximum activity hold (ms)
                  <input
                    type="number"
                    min="0"
                    max="10000"
                    value={hold}
                    disabled={busy}
                    onChange={(e) => setHold(e.currentTarget.valueAsNumber)}
                  />
                </label>
                <label>
                  Activity above noise (dB)
                  <input
                    type="number"
                    min="3"
                    max="60"
                    value={threshold}
                    disabled={busy}
                    onChange={(e) =>
                      setThreshold(e.currentTarget.valueAsNumber)
                    }
                  />
                </label>
                <label>
                  Alert cooldown (ms)
                  <input
                    type="number"
                    min="1000"
                    max="3600000"
                    value={cooldown}
                    disabled={busy}
                    onChange={(e) => setCooldown(e.currentTarget.valueAsNumber)}
                  />
                </label>
                <label className="receiver-auto-center receiver-tool-toggle">
                  <input
                    type="checkbox"
                    checked={listen}
                    disabled={busy}
                    onChange={(e) => setListen(e.currentTarget.checked)}
                  />
                  <span className="receiver-switch-track" aria-hidden="true" />
                  Listen during channel visits
                </label>
                <label className="receiver-auto-center receiver-tool-toggle">
                  <input
                    type="checkbox"
                    checked={capture}
                    disabled={busy || recordings.length > 0}
                    onChange={(e) => setCapture(e.currentTarget.checked)}
                  />
                  <span className="receiver-switch-track" aria-hidden="true" />
                  Capture native I/Q on an activity event
                </label>
                {capture && (
                  <>
                    <label>
                      Pre-trigger seconds
                      <input
                        type="number"
                        min="0"
                        max="2"
                        step="0.1"
                        value={pre}
                        disabled={busy}
                        onChange={(e) => setPre(e.currentTarget.valueAsNumber)}
                      />
                    </label>
                    <label>
                      Post-trigger seconds
                      <input
                        type="number"
                        min="0.1"
                        max="10"
                        step="0.1"
                        value={post}
                        disabled={busy}
                        onChange={(e) => setPost(e.currentTarget.valueAsNumber)}
                      />
                    </label>
                    <small>
                      8 MiB pre-trigger ring; 16 MiB per capture, three captures
                      / 48 MiB per run. Duration can be shorter at high rates.
                      Captures stay in this tab until downloaded or discarded.
                    </small>
                  </>
                )}
              </div>

              <p>
                {events.length} retained activity events (maximum 64). Activity
                is not protocol or transmitter identification.
              </p>
              {events.length > 0 && (
                <InstrumentButton
                  className="secondary"
                  onClick={() => {
                    void import("../radio/recordingExportFormat")
                      .then((exporter) =>
                        exporter.triggerFileDownload({
                          name: "browsersdr-watch-events.json",
                          type: "application/json",
                          contents: JSON.stringify(
                            {
                              schema: "browsersdr-watch-events-v1",
                              clock: "host-observation-time",
                              units: "relative-dB-above-measured-noise",
                              events,
                            },
                            null,
                            2,
                          ),
                        }),
                      )
                      .catch((error) => setMessage(String(error)));
                  }}
                >
                  Export activity events JSON
                </InstrumentButton>
              )}
              {events.length > 0 && (
                <details>
                  <summary>Activity events</summary>
                  <ol>
                    {events.map((event, index) => (
                      <li key={index}>
                        {event.observedAt} · {event.kind} · {event.name} ·{" "}
                        {event.aboveNoiseDb.toFixed(1)} dB above noise
                      </li>
                    ))}
                  </ol>
                </details>
              )}
              {recordings.map((recording, index) => (
                <div key={index}>
                  <span>
                    Event {index + 1} ·{" "}
                    {recording.metadata.durationSeconds.toFixed(3)} s ·{" "}
                    {recording.metadata.stopReason}
                  </span>
                  <InstrumentButton onClick={() => void downloadCapture(recording)}>
                    Download event {index + 1} SigMF ZIP
                  </InstrumentButton>
                </div>
              ))}
              {recordings.length > 0 && (
                <p>
                  Download or discard retained event captures before another
                  captured watch run.
                </p>
              )}
              {recordings.length > 0 && (
                <InstrumentButton
                  className="secondary"
                  disabled={Boolean(operation)}
                  onClick={() => {
                    if (
                      window.confirm(
                        "Discard the retained event captures from this tab?",
                      )
                    )
                      setRecordings([]);
                  }}
                >
                  Discard event captures
                </InstrumentButton>
              )}
              {messageLocation === "watch" && message && (
                <p role="status">{message}</p>
              )}
            </section>
          </div>,
          watchTarget,
        )}
      {messageLocation === "acquire" && message && (
        <p role="status">{message}</p>
      )}
    </div>
  );
}

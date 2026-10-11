import { useMemo, useState, useSyncExternalStore, type ReactNode } from "react";
import type {
  ReceiverController,
  ReceiverSnapshot,
} from "../radio/receiverController";
import type { ReceiverMode } from "../radio/receiverConfig";
import type { SourceKind } from "../radio/types";
import { DecodedResults } from "./DecodedResults";
import { PositionMap } from "./PositionMap";
import { DabMetadata } from "./DabMetadata";
import { AppIcon } from "./AppIcon";
import {
  DECODER_FORMATS,
  decoderAcceptedCount,
  decoderIdentity,
  decoderJson,
  decoderRecords,
  decoderRetention,
  decoderViewExport,
  type DecoderFormat,
  type DecoderRecord,
} from "./decoderViewModel";

interface ReviewSnapshot {
  identity: string;
  receiver: ReceiverSnapshot;
  results: DecoderRecord[];
  messages: DecoderRecord[];
  accepted: number;
  frozenAt?: string;
}

export interface DecoderWorkspaceProps {
  controller: ReceiverController;
  source: SourceKind;
  mode: ReceiverMode;
  configuredMode: ReceiverMode;
  volume: number;
  frequencyHz: number;
  sampleRateHz: number;
  active: boolean;
  remote: boolean;
  blockedReason?: string;
  unavailableReason: (mode: ReceiverMode) => string | undefined;
  configurationPreview: (mode: ReceiverMode) => string;
  onApply: (mode: ReceiverMode) => void;
  onOpenReceiver: () => void;
  onOpenRecording: () => void;
  onVolumeChange: (volume: number) => void;
  serviceControl?: ReactNode;
}

/** Another view of the existing controller; no acquisition or decoder is started here. */
export function DecoderWorkspace(props: DecoderWorkspaceProps) {
  const receiver = useSyncExternalStore(
    props.controller.subscribe,
    props.controller.getSnapshot,
  );
  const [browsedFormat, setBrowsedFormat] = useState<DecoderFormat>();
  const [frozen, setFrozen] = useState<ReviewSnapshot>();
  const [selectedKey, setSelectedKey] = useState("");
  const [filter, setFilter] = useState("");
  const [view, setView] = useState<{
    format: DecoderFormat;
    value: "results" | "messages" | "map";
  }>();
  const [exportScope, setExportScope] = useState<"retained" | "selected">(
    "retained",
  );
  const [issue, setIssue] = useState("");
  const [audibleVolume, setAudibleVolume] = useState(props.volume || 0.7);
  const [toolsOpen, setToolsOpen] = useState(false);
  const [showTracks, setShowTracks] = useState(true);
  const nativeFormat = DECODER_FORMATS.find(
    (f) =>
      f.mode ===
      (receiver.lifecycle === "connected" ? props.configuredMode : props.mode),
  )?.mode;
  const format = browsedFormat ?? nativeFormat ?? "WBFM";
  const satellite = format === "satellite";
  const reviewMode = satellite ? "OFF" : format;
  const identity = decoderIdentity(
    receiver,
    reviewMode,
    props.remote ? "remote" : props.source,
  );
  const modeChangePending =
    receiver.lifecycle === "tuning" && receiver.message.startsWith("Applying ");
  const applied =
    !props.remote &&
    !modeChangePending &&
    props.mode === reviewMode &&
    (!receiver.session || receiver.session.source === props.source);
  const needsApply =
    props.remote ||
    props.configuredMode !== reviewMode ||
    (receiver.lifecycle === "running" && props.mode !== reviewMode);
  const live = useMemo<ReviewSnapshot>(
    () => ({
      identity,
      // Exports carry acquisition metadata, never audio/artwork buffers or controller internals.
      receiver: {
        lifecycle: receiver.lifecycle,
        message: receiver.message,
        sessionGeneration: receiver.sessionGeneration,
        session: receiver.session,
      },
      results: applied ? decoderRecords(receiver, reviewMode) : [],
      messages: applied ? decoderRecords(receiver, reviewMode, true) : [],
      accepted: applied ? decoderAcceptedCount(receiver, reviewMode) : 0,
    }),
    [identity, receiver, applied, reviewMode],
  );
  const held = frozen?.identity === identity ? frozen : undefined;
  const display = held ?? live;
  const hasMessages = ["APRS", "RS41", "SRD"].includes(reviewMode);
  const supportsMap = ["ADS-B", "AIS", "APRS", "RS41"].includes(reviewMode);
  const preferredView =
    view?.format === format
      ? view.value
      : ["ADS-B", "AIS"].includes(reviewMode)
        ? "map"
        : "results";
  const effectiveView =
    (preferredView === "messages" && !hasMessages) ||
    (preferredView === "map" && !supportsMap)
      ? "results"
      : preferredView;
  const records =
    effectiveView === "messages" ? display.messages : display.results;
  const filtered = records.filter((r) =>
    `${r.label} ${r.summary} ${r.fields.flat().join(" ")}`
      .toLowerCase()
      .includes(filter.toLowerCase()),
  );
  const selected = filtered.find((r) => r.key === selectedKey) ?? filtered[0];
  const unavailable = props.remote
    ? "Remote audio/FFT does not provide the raw I/Q input required by these decoders. Select a local source in Receiver."
    : props.source === "synthetic"
      ? "The generated demo has no received digital data. Choose hardware or a compatible I/Q recording in Receiver."
      : satellite
        ? undefined
        : props.unavailableReason(reviewMode);
  const applyBlocked = props.blockedReason || unavailable;
  const metadata = display.receiver.session;
  const title =
    DECODER_FORMATS.find((f) => f.mode === format)?.title ??
    "Satellite recordings";
  const retention = decoderRetention(reviewMode);
  const empty = modeChangePending
    ? "Applying the decoder configuration. Results will appear when the receiver is ready."
    : needsApply
      ? "This format is a preview. Apply it to the shared receiver before decoding."
      : receiver.lifecycle !== "running"
        ? "No retained results. Open Receiver to connect and start, or open an I/Q recording."
        : "Receiving, but no results have been accepted yet. Check the signal, frequency and input requirements in Receiver.";

  function freezeDisplay() {
    setIssue("");
    if (held) {
      setFrozen(undefined);
      return;
    }
    // Validate both bounded views before copying. Typed arrays stay typed in the held snapshot.
    try {
      decoderViewExport(
        live.receiver,
        reviewMode,
        [...live.results, ...(hasMessages ? live.messages : [])],
        "retained",
        true,
      );
      setFrozen({
        ...structuredClone(live),
        frozenAt: new Date().toLocaleTimeString(),
      });
    } catch (error) {
      setIssue(
        error instanceof Error ? error.message : "Cannot freeze these results.",
      );
    }
  }
  function exportResults() {
    setIssue("");
    try {
      const json = decoderViewExport(
        display.receiver,
        reviewMode,
        exportScope === "selected" && selected ? [selected] : records,
        exportScope,
        Boolean(held),
      );
      const url = URL.createObjectURL(
        new Blob([json], { type: "application/json" }),
      );
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = `browsersdr-${reviewMode.toLowerCase()}-${exportScope}.json`;
      anchor.click();
      window.setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (error) {
      setIssue(
        error instanceof Error ? error.message : "Cannot export these results.",
      );
    }
  }

  return (
    <section
      id="decoder-view"
      role="tabpanel"
      aria-labelledby="decoder-tab"
      hidden={!props.active}
      className="decoder-workbench"
    >
      {props.active && (
        <>
          <aside
            className="control-panel decoder-rail"
            aria-label="Decoder setup"
          >
            <div className="decoder-eyebrow">DECODER WORKBENCH</div>
            <h2>Known signal, useful data.</h2>
            <label htmlFor="decoder-format">Format</label>
            <select
              id="decoder-format"
              value={format}
              onChange={(event) => {
                setBrowsedFormat(event.currentTarget.value as DecoderFormat);
                setFrozen(undefined);
                setSelectedKey("");
                setFilter("");
                setIssue("");
                setView(undefined);
              }}
            >
              {DECODER_FORMATS.map((f) => (
                <option key={f.mode} value={f.mode}>
                  {f.label}
                </option>
              ))}
              <option value="satellite">Satellite · Recording workflow</option>
            </select>
            <dl className="decoder-context">
              <div>
                <dt>Input</dt>
                <dd>
                  {props.remote
                    ? "Remote audio / FFT"
                    : props.source === "synthetic"
                      ? "Generated demo"
                      : props.source}
                </dd>
              </div>
              <div>
                <dt>Channel</dt>
                <dd>
                  {props.remote
                    ? "See remote Receiver"
                    : `${((receiver.session?.selectedChannelFrequencyHz ?? props.frequencyHz) / 1e6).toLocaleString(undefined, { maximumFractionDigits: 6 })} MHz`}
                </dd>
              </div>
              <div>
                <dt>Input rate</dt>
                <dd>
                  {props.remote
                    ? "No raw I/Q rate"
                    : `${(receiver.session?.actualSampleRateHz ?? props.sampleRateHz).toLocaleString()} samples/s`}
                </dd>
              </div>
              <div>
                <dt>Applied mode</dt>
                <dd>
                  {props.remote ? "Local decoders unavailable" : props.mode}
                </dd>
              </div>
              {!props.remote && props.mode !== props.configuredMode && (
                <div>
                  <dt>Configured for next start</dt>
                  <dd>{props.configuredMode}</dd>
                </div>
              )}
            </dl>
            {!satellite && (
              <>
                <p className="decoder-hint">
                  {!needsApply
                    ? "Using the shared receiver. Changing views preserves its current state."
                    : `Apply ${reviewMode} to replace ${props.configuredMode}. ${props.configurationPreview(reviewMode)}`}
                </p>
                {needsApply && (
                  <button
                    type="button"
                    disabled={Boolean(applyBlocked)}
                    onClick={() => {
                      props.onApply(reviewMode);
                      setIssue("");
                    }}
                  >
                    Apply {reviewMode}
                  </button>
                )}
                {applyBlocked && <p className="decoder-hint">{applyBlocked}</p>}
              </>
            )}
            <button
              type="button"
              className="secondary"
              onClick={props.onOpenReceiver}
            >
              <AppIcon name="radio" />
              Open Receiver
            </button>
            <button
              type="button"
              className="secondary"
              disabled={props.remote}
              onClick={props.onOpenRecording}
            >
              <AppIcon name="folder" />
              Open I/Q recording
            </button>
            {applied && ["WBFM", "DAB"].includes(reviewMode) && (
              <div className="decoder-audio">
                <h3>Shared audio</h3>
                <label htmlFor="decoder-volume">
                  Volume · {Math.round(props.volume * 100)}%
                </label>
                <input
                  id="decoder-volume"
                  type="range"
                  min="0"
                  max="1"
                  step="0.01"
                  value={props.volume}
                  onChange={(event) =>
                    props.onVolumeChange(event.currentTarget.valueAsNumber)
                  }
                />
                <button
                  type="button"
                  className="secondary"
                  onClick={() => {
                    if (props.volume > 0) {
                      setAudibleVolume(props.volume);
                      props.onVolumeChange(0);
                    } else props.onVolumeChange(audibleVolume);
                  }}
                >
                  {props.volume > 0 ? "Mute audio" : "Unmute audio"}
                </button>
                {reviewMode === "DAB" && props.serviceControl}
              </div>
            )}
            <p className="decoder-hint">
              Results are kept in this page: up to {retention.maximumResults}{" "}
              {retention.maximumResults === 1 ? "result" : "results"}
              {retention.maximumMessages
                ? ` and ${retention.maximumMessages} recent records`
                : ""}
              . Protocol fields may be retained from earlier accepted records.
              Export to save a reviewed result.
            </p>
          </aside>

          <section
            className="control-panel decoder-stage"
            aria-label="Decoded results"
          >
            <div className="decoder-stage-heading">
              <div>
                <div className="decoder-eyebrow">
                  {satellite ? "RECORDING WORKFLOW" : reviewMode}
                </div>
                <h2>{title}</h2>
              </div>
              <span className="decoder-state">
                {held
                  ? "Display frozen"
                  : modeChangePending
                    ? "Applying configuration"
                    : applied
                      ? receiver.lifecycle === "running"
                        ? "Live input"
                        : "Retained / idle"
                      : !needsApply
                        ? "Configured / idle"
                        : "Preview"}
              </span>
            </div>
            {satellite ? (
              <div className="decoder-empty">
                <AppIcon name="folder" />
                <h3>Start with an original I/Q recording</h3>
                <p>
                  Use Receiver’s capture and replay workflow to retain the
                  original samples and acquisition metadata. Satellite image
                  decoding is a planned extension; this build has no native LRPT
                  decoder or image output.
                </p>
                {props.remote && <p>{unavailable}</p>}
                <button
                  type="button"
                  disabled={props.remote}
                  onClick={props.onOpenRecording}
                >
                  Open recording workflow
                </button>
              </div>
            ) : (
              <>
                <div className="decoder-actions">
                  <button
                    type="button"
                    className="secondary"
                    onClick={freezeDisplay}
                    disabled={!applied || !records.length}
                  >
                    <AppIcon name={held ? "play" : "pause"} />
                    {held ? "Resume live display" : "Freeze display"}
                  </button>
                  <label className="decoder-filter">
                    Filter results
                    <input
                      type="search"
                      placeholder="Identity or decoded field"
                      value={filter}
                      onChange={(event) => setFilter(event.currentTarget.value)}
                    />
                  </label>
                  <label>
                    Export scope
                    <select
                      value={exportScope}
                      onChange={(event) =>
                        setExportScope(
                          event.currentTarget.value as "retained" | "selected",
                        )
                      }
                    >
                      <option value="retained">
                        Retained{" "}
                        {effectiveView === "messages" ? "messages" : "results"}
                      </option>
                      <option value="selected">Selected record</option>
                    </select>
                  </label>
                  <button
                    type="button"
                    className="secondary"
                    disabled={
                      !records.length ||
                      (exportScope === "selected" && !selected)
                    }
                    onClick={exportResults}
                  >
                    <AppIcon name="download" />
                    Export JSON
                  </button>
                </div>
                <p className="decoder-review-status">
                  {held
                    ? `Frozen at ${held.frozenAt}. Reception continues; ${Math.max(0, live.accepted - held.accepted).toLocaleString()} additional accepted ${reviewMode === "WBFM" ? "groups" : reviewMode === "DAB" ? "FIC blocks" : reviewMode === "SRD" ? "readings" : "frames"}.`
                    : `${records.length} retained ${effectiveView === "messages" ? "records" : "results"} · ${live.accepted.toLocaleString()} accepted ${reviewMode === "WBFM" ? "groups" : reviewMode === "DAB" ? "FIC blocks" : reviewMode === "SRD" ? "readings" : "frames"}`}
                  {filter &&
                    ` · ${filtered.length} match the filter; retained export includes unfiltered records.`}
                </p>
                {frozen && !held && (
                  <p className="decoder-hint">
                    The source, format or acquisition generation changed. The
                    previous frozen display has been cleared.
                  </p>
                )}
                {issue && <p role="alert">{issue}</p>}
                {(hasMessages || supportsMap) && (
                  <div
                    className="decoder-view-options"
                    role="group"
                    aria-label="Result presentation"
                  >
                    <button
                      type="button"
                      className="secondary"
                      aria-pressed={effectiveView === "results"}
                      onClick={() => setView({ format, value: "results" })}
                    >
                      Results
                    </button>
                    {hasMessages && (
                      <button
                        type="button"
                        className="secondary"
                        aria-pressed={effectiveView === "messages"}
                        onClick={() => setView({ format, value: "messages" })}
                      >
                        {reviewMode === "RS41"
                          ? "Frames"
                          : reviewMode === "SRD"
                            ? "Bursts"
                            : "Messages"}
                      </button>
                    )}
                    {effectiveView === "map" &&
                      (reviewMode === "ADS-B" || reviewMode === "AIS") && (
                      <label className="checkbox-control target-track-toggle">
                          <input
                            type="checkbox"
                            checked={showTracks}
                            onChange={(event) =>
                              setShowTracks(event.target.checked)
                            }
                          />
                          Show tracks
                        </label>
                      )}
                    {supportsMap && (
                      <button
                        type="button"
                        className="secondary"
                        aria-pressed={effectiveView === "map"}
                        onClick={() => setView({ format, value: "map" })}
                      >
                        Map & results
                      </button>
                    )}
                  </div>
                )}
                {!filtered.length ? (
                  <div className="decoder-empty">
                    <AppIcon name="radio" />
                    <h3>
                      {filter
                        ? "No matching results"
                        : "Waiting for decoded data"}
                    </h3>
                    <p>
                      {filter
                        ? "Change or clear the filter to see retained results."
                        : unavailable || empty}
                    </p>
                  </div>
                ) : (
                  <>
                    {effectiveView === "map" && (
                      <PositionMap
                        label={`${reviewMode} decoded positions`}
                        showTracks={
                          (reviewMode === "ADS-B" || reviewMode === "AIS") &&
                          showTracks
                        }
                        points={filtered.map((r) => ({
                          latitude: r.latitude ?? null,
                          longitude: r.longitude ?? null,
                          label: r.label,
                          key: r.key,
                          map: r.map,
                        }))}
                        selectedKey={selected?.key}
                        onPointSelect={setSelectedKey}
                      />
                    )}
                    <div
                      className="decoder-record-list"
                      aria-label="Retained decoded records"
                    >
                      {filtered.map((r) => (
                        <button
                          type="button"
                          key={r.key}
                          className="decoder-record"
                          aria-pressed={selected?.key === r.key}
                          onClick={() => setSelectedKey(r.key)}
                        >
                          <strong>{r.label}</strong>
                          <span>{r.summary}</span>
                          <small>{r.clock}</small>
                        </button>
                      ))}
                    </div>
                  </>
                )}
                {applied && reviewMode === "DAB" && (
                  <section
                    aria-label="Selected DAB service metadata"
                    className="decoder-broadcast"
                  >
                    <h3>Selected service · live text & slideshow</h3>
                    {held && (
                      <p className="decoder-hint">
                        Broadcast media continues live while the service list is
                        frozen.
                      </p>
                    )}
                    <DabMetadata metadata={receiver.dab?.programmeMetadata} />
                  </section>
                )}
                <details
                  className="decoder-reception-details"
                  open={toolsOpen}
                  onToggle={(event) => setToolsOpen(event.currentTarget.open)}
                >
                  <summary>Reception details & protocol tools · live</summary>
                  <p className="decoder-hint">
                    These existing audio, metadata, integrity and protocol
                    export tools follow the live receiver even when the review
                    display is frozen.
                  </p>
                  {toolsOpen && (
                    <DecodedResults
                      receiver={receiver}
                      source={props.source}
                      mode={props.mode}
                      volume={props.volume}
                      active
                      panelId="decoder-protocol-tools"
                    />
                  )}
                </details>
              </>
            )}
          </section>

          <aside
            className="control-panel decoder-inspector"
            aria-label="Selected decoded record"
          >
            <div className="decoder-eyebrow">SELECTED RECORD</div>
            <h2>{selected?.label ?? "Inspect a result"}</h2>
            {selected && !satellite ? (
              <>
                <p>{selected.summary}</p>
                <p className="decoder-integrity">{selected.integrity}</p>
                <dl className="decoder-context">
                  {selected.fields.map(([name, val]) => (
                    <div key={name}>
                      <dt>{name}</dt>
                      <dd>{val}</dd>
                    </div>
                  ))}
                  <div>
                    <dt>Receive clock</dt>
                    <dd>{selected.clock}</dd>
                  </div>
                  <div>
                    <dt>Acquisition</dt>
                    <dd>
                      {metadata
                        ? `${metadata.source} · generation ${metadata.sessionGeneration}`
                        : `generation ${display.receiver.sessionGeneration}`}
                    </dd>
                  </div>
                </dl>
                <details>
                  <summary>Raw published record</summary>
                  <pre>{decoderJson(selected.raw)}</pre>
                </details>
              </>
            ) : (
              <p className="decoder-hint">
                Select a received result to inspect its fields, integrity and
                original decoder clock. Unknown fields stay unknown.
              </p>
            )}
          </aside>
        </>
      )}
    </section>
  );
}

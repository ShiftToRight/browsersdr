import { isTextMode } from "../textmodem/settings";
import { lazy, Suspense } from "react";
const TextDecodePanel = lazy(() => import("./TextDecodePanel").then(module => ({ default: module.TextDecodePanel })));
import { useVisibleReceiver } from "./useVisibleReceiver";
import type {
  ReceiverController,
  ReceiverSnapshot,
} from "../radio/receiverController";
import type { SourceKind } from "../radio/types";
import type { ReceiverMode } from "../radio/receiverConfig";
import { isWidebandRate } from "../radio/sourceCapabilities";
const PacketDecodePanel = lazy(() => import("./PacketDecodePanel").then(module => ({ default: module.PacketDecodePanel })));
const DabMetadata = lazy(() => import("./DabMetadata").then(module => ({ default: module.DabMetadata })));
import { AppIcon } from "./AppIcon";
import { AudioCapturePanel } from "./AudioCaptureSection";
function downloadDecodedTargets(mode: string, targets: unknown[]): void {
  const url = URL.createObjectURL(
    new Blob(
      [
        JSON.stringify(
          { mode, exportedAt: new Date().toISOString(), targets },
          null,
          2,
        ),
      ],
      { type: "application/json" },
    ),
  );
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `browsersdr-${mode.toLowerCase().replace(/[^a-z0-9]+/g, "-")}-targets.json`;
  anchor.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 0);
}

function downloadSrdSnapshot(receiver: ReceiverSnapshot): void {
  if (!receiver.srd || !receiver.session) return;
  const session = receiver.session;
  downloadDecodedTargets("SRD", [
    {
      schema: "browsersdr-srd-export-v1",
      settings: session.srd,
      provenance: {
        source: session.source,
        generation: session.sessionGeneration,
        actualInputSampleRateHz: session.actualSampleRateHz,
        hardwareCenterFrequencyHz: session.hardwareCenterFrequencyHz,
        selectedChannelFrequencyHz: session.selectedChannelFrequencyHz,
        selectedChannelOffsetHz:
          session.selectedChannelFrequencyHz -
          session.hardwareCenterFrequencyHz,
        decoderInputOffsetHz: isWidebandRate(session.actualSampleRateHz)
          ? 0
          : session.selectedChannelFrequencyHz -
            session.hardwareCenterFrequencyHz,
      },
      integrityPolicy: "Only protocol-validated readings are included.",
      units: {
        temperatureC: "degC",
        humidityPercent: "percent",
        moisturePercent: "percent",
        batteryMillivolts: "mV",
      },
      counters: receiver.srd.counters,
      readings: receiver.srd.recentReadings.slice(-32),
      bursts: receiver.srd.bursts.slice(-4),
      worker: receiver.srdWorker,
    },
  ]);
}

export function DecodedResults({
  receiver,
  source,
  mode,
  volume,
  active = true,
  panelId = "decode-panel",
  onOpenDecoder,
}: {
  receiver: ReceiverSnapshot;
  source: SourceKind;
  mode: ReceiverMode;
  volume: number;
  active?: boolean;
  panelId?: string;
  onOpenDecoder?: () => void;
}) {
  // A mode switch publishes the selected mode before the new decoder has
  // finished configuring. Avoid pairing that mode with the previous decoder's
  // last status during the tuning window.
  const modeChangePending =
    receiver.lifecycle === "tuning" && receiver.message.startsWith("Applying ");
  return (
    <section
      id={panelId}
      role="tabpanel"
      className="control-panel rds-panel decode-panel receiver-dock-panel"
      data-mode={mode}
      aria-labelledby={`${panelId}-heading`}
      hidden={!active}
    >
      <h2 id={`${panelId}-heading`} className="visually-hidden">
        Decoded data
      </h2>
      <AudioCapturePanel />
      <div className="decode-layout">
        <div className="audio-summary">
          <span>
            {modeChangePending
              ? "Mode change"
              : mode === "OFF"
                ? "Demodulation disabled"
                : mode === "DAB"
                  ? "DAB+ audio output"
                  : ["ADS-B", "AIS", "SRD", "APRS", "RS41", "RTTY", "PSK31", "NAVTEX", "ACARS"].includes(mode)
                    ? "Data acquisition"
                    : "Audio output"}
          </span>
          <strong>
            {modeChangePending
              ? receiver.message
              : mode === "OFF"
                ? "No audio or decoder output"
                : mode === "DAB"
                  ? (receiver.dab?.message ?? "Not active")
                  : isTextMode(mode) ? `${receiver.textModem?.counters.characters ?? 0} decoded characters` : mode === "APRS"
                    ? `${receiver.aprs?.stations.length ?? 0} validated station(s)`
                    : mode === "RS41"
                      ? `${receiver.rs41?.sondes.length ?? 0} validated sonde(s)`
                      : mode === "ADS-B"
                        ? (receiver.adsb?.message ?? "Not active")
                        : mode === "AIS"
                          ? (receiver.ais?.message ?? "Not active")
                          : mode === "SRD"
                            ? receiver.srd
                              ? `${receiver.srd.devices.length} validated device(s)`
                              : "Not active"
                            : source === "synthetic"
                              ? "Not available in demo"
                              : (receiver.audioState ?? "Not active")}
          </strong>
          <small>
            {mode === "OFF"
              ? "Raw I/Q continues to feed the spectrum, waterfall, surveys and recordings."
              : mode === "DAB"
                ? `Mode I · browser HE-AAC · ${Math.round(volume * 100)}% volume`
                : isTextMode(mode) ? "Receive-only text · open Decoder for messages and export" : mode === "APRS"
                  ? "1200-baud Bell-202 · AX.25 FCS"
                  : mode === "RS41"
                    ? "4800 bit/s · unencrypted RS41"
                    : mode === "ADS-B"
                      ? "1090ES · CRC-validated Mode S frames"
                      : mode === "AIS"
                        ? "AIS 1 + AIS 2 · dual-channel GMSK"
                        : mode === "SRD"
                          ? "OOK / 2-FSK signal inspection"
                          : source === "synthetic"
                            ? "Use a hardware source or replay to listen."
                            : `${mode} demodulation · ${Math.round(volume * 100)}% volume`}
          </small>
          {onOpenDecoder && (
            <button
              type="button"
              className="secondary decode-workspace-link"
              onClick={onOpenDecoder}
              title="Review messages, maps and broadcast data in the full workspace."
            >
              <AppIcon name="overlay" />
              Open Decoder
            </button>
          )}
          <span
            className={`status-pill ${!modeChangePending && (isTextMode(mode) ? receiver.textModem?.status === "decoding" : mode === "DAB" ? receiver.dab?.state === "synchronized" : mode === "ADS-B" ? receiver.adsb?.validFrames : mode === "AIS" ? receiver.ais?.validFrames : mode === "SRD" ? receiver.srd?.counters.bursts : mode === "APRS" ? receiver.aprs?.counters.validAx25Frames : mode === "RS41" ? receiver.rs41?.counters.uncorrectedFrames || receiver.rs41?.counters.correctedFrames : receiver.rds?.validGroups) ? "status-running" : "status-idle"}`}
          >
            {modeChangePending
              ? "reconfiguring"
              : mode === "OFF"
                ? "spectrum only"
                : mode === "DAB"
                  ? (receiver.dab?.state ?? "not started")
                  : mode === "ADS-B"
                    ? `${receiver.adsb?.validFrames ?? 0} valid frames`
                    : isTextMode(mode) ? receiver.textModem?.status ?? "not started" : mode === "APRS"
                      ? `${receiver.aprs?.counters.validAx25Frames ?? 0} FCS-valid packets`
                      : mode === "RS41"
                        ? `${(receiver.rs41?.counters.uncorrectedFrames ?? 0) + (receiver.rs41?.counters.correctedFrames ?? 0)} integrity-valid frames`
                        : mode === "AIS"
                          ? `${receiver.ais?.validFrames ?? 0} valid frames`
                          : mode === "SRD"
                            ? `${receiver.srd?.counters.bursts ?? 0} bursts`
                            : receiver.rds?.validGroups
                              ? `${receiver.rds.validGroups} valid groups`
                              : source === "synthetic"
                                ? "no audio"
                                : `${mode} audio`}
          </span>
        </div>
        {source !== "synthetic" &&
          ["WBFM", "DAB", "ADS-B", "AIS", "SRD", "APRS", "RS41", "RTTY", "PSK31", "NAVTEX", "ACARS"].includes(
            mode,
          ) && (
            <div className="rds-content">
              <h3>
                {mode === "OFF"
                  ? "Spectrum explorer"
                  : mode === "DAB"
                    ? "Digital Audio Broadcasting"
                    : mode === "ADS-B"
                      ? "Aircraft targets"
                      : mode === "AIS"
                        ? "Vessel targets"
                        : isTextMode(mode) ? `${mode === "PSK31" ? "BPSK31" : mode} text & messages` : mode === "APRS"
                          ? "APRS stations"
                          : mode === "RS41"
                            ? "RS41 radiosondes"
                            : mode === "SRD"
                              ? "Short-range devices"
                              : "Radio Data System"}
              </h3>
              {mode === "OFF" ? (
                <p className="rds-empty">
                  Spectrum-only mode keeps RF acquisition and analysis active
                  without sending samples to an audio or digital decoder.
                </p>
              ) : isTextMode(mode) ? <Suspense fallback={<p role="status">Loading decoded text…</p>}><TextDecodePanel receiver={receiver} mode={mode} /></Suspense> : mode === "APRS" || mode === "RS41" ? (
                <Suspense fallback={<p role="status">Loading packet details…</p>}><PacketDecodePanel receiver={receiver} mode={mode} /></Suspense>
              ) : mode === "SRD" ? (
                <>
                  <div className="target-table-wrap">
                    <table className="target-table">
                      <thead>
                        <tr>
                          <th>Device</th>
                          <th>Protocol / integrity</th>
                          <th>Measurements</th>
                          <th>Last sample</th>
                        </tr>
                      </thead>
                      <tbody>
                        {(receiver.srd?.devices ?? [])
                          .slice(0, 32)
                          .map((device) => {
                            const reading = device.reading;
                            return (
                              <tr key={device.key}>
                                <td>
                                  <strong>{reading.deviceId}</strong>
                                  <small>
                                    {device.readings} validated reading(s)
                                  </small>
                                </td>
                                <td>
                                  {reading.protocol}
                                  <small>{reading.integrity}</small>
                                </td>
                                <td>
                                  {reading.protocol === "acurite-592txr"
                                    ? `${reading.temperatureC.toFixed(1)} °C${reading.humidityPercent == null ? "" : ` · ${reading.humidityPercent}% RH`}`
                                    : `${reading.moisturePercent}% moisture · ${reading.batteryMillivolts} mV`}
                                </td>
                                <td>
                                  {device.lastInputSampleIndex.toLocaleString()}
                                </td>
                              </tr>
                            );
                          })}
                        {!receiver.srd?.devices.length && (
                          <tr>
                            <td colSpan={4}>
                              No integrity-validated sensor reading yet.
                            </td>
                          </tr>
                        )}
                      </tbody>
                    </table>
                  </div>

                  <button
                    type="button"
                    className="secondary"
                    disabled={!receiver.srd}
                    onClick={() => downloadSrdSnapshot(receiver)}
                  >
                    Export device data (JSON)
                  </button>
                  <details className="decoder-details">
                    <summary>Decoder details</summary>{" "}
                    <dl className="rds-grid">
                      <div>
                        <dt>Bursts</dt>
                        <dd>{receiver.srd?.counters.bursts ?? 0}</dd>
                      </div>
                      <div>
                        <dt>Validated readings</dt>
                        <dd>{receiver.srd?.counters.validatedReadings ?? 0}</dd>
                      </div>
                      <div>
                        <dt>Unknown / rejected</dt>
                        <dd>
                          {receiver.srd?.counters.rejectedProtocolFrames ?? 0}
                        </dd>
                      </div>
                      <div>
                        <dt>Queue drops</dt>
                        <dd>{receiver.srdWorker?.droppedInputBlocks ?? 0}</dd>
                      </div>
                    </dl>{" "}
                    <div
                      className="srd-trace"
                      aria-label="Bounded SRD pulse inspector"
                    >
                      {(receiver.srd?.trace ?? [])
                        .slice(-512)
                        .map((point, index) => (
                          <i
                            key={`${point.inputSampleIndex}:${index}`}
                            className={point.level ? "high" : "low"}
                            title={`${point.inputSampleIndex}: envelope ${point.envelope.toFixed(3)}, discriminator ${point.discriminatorHz.toFixed(0)} Hz`}
                          />
                        ))}
                    </div>
                    <p className="display-note">
                      {receiver.srd?.activeBurst
                        ? "Burst in progress…"
                        : receiver.srd?.bursts.length
                          ? `${receiver.srd.bursts.length} recent burst(s); truncated bursts are marked below.`
                          : "Waiting for a signal burst. Unknown signals appear in the inspector."}
                    </p>
                    <details>
                      <summary>Recent pulse bursts</summary>
                      <ul className="srd-burst-list">
                        {(receiver.srd?.bursts ?? []).slice(-4).map((burst) => (
                          <li key={burst.id}>
                            Burst {burst.id}: {burst.pulses.length} pulses
                            {burst.truncated
                              ? ` · truncated (${burst.truncationReason ?? "unknown"})`
                              : ""}
                            {burst.timingCandidates[0]
                              ? ` · candidate ${burst.timingCandidates[0].symbolUs.toFixed(0)} µs (${burst.timingCandidates[0].basis})`
                              : ""}
                          </li>
                        ))}
                      </ul>
                    </details>
                  </details>
                </>
              ) : mode === "DAB" ? (
                <>
                  <p className="display-note">
                    Ensemble:{" "}
                    <strong>
                      {receiver.dab?.ensemble?.label ||
                        "Waiting for ensemble name…"}
                    </strong>
                  </p>
                  <Suspense fallback={<p role="status">Loading DAB programme details…</p>}><DabMetadata metadata={receiver.dab?.programmeMetadata} /></Suspense>
                  <details className="decoder-details">
                    <summary>Decoder details</summary>
                    <p className="display-note">
                      Broadcast metadata:{" "}
                      {receiver.dab?.padStatistics?.padUnits ?? 0} PAD units ·{" "}
                      {receiver.dab?.padStatistics?.labelGroups ?? 0} text
                      segments · {receiver.dab?.padStatistics?.motGroups ?? 0}{" "}
                      image segments ·{" "}
                      {receiver.dab?.padStatistics?.motObjects ?? 0} completed
                      images
                      {receiver.dab?.padStatistics?.motBytes
                        ? ` · ${(receiver.dab.padStatistics.motBytes / 1024).toFixed(1)} KB assembling`
                        : ""}
                    </p>
                    <dl className="rds-grid">
                      <div>
                        <dt>Transmission frames</dt>
                        <dd>{receiver.dab?.frameCount ?? 0}</dd>
                      </div>
                      <div>
                        <dt>Null symbols</dt>
                        <dd>{receiver.dab?.nullSymbolCount ?? 0}</dd>
                      </div>
                      <div>
                        <dt>Estimated signal/null</dt>
                        <dd>
                          {receiver.dab?.estimatedSnrDb == null
                            ? "—"
                            : `${receiver.dab.estimatedSnrDb.toFixed(1)} dB`}
                        </dd>
                      </div>
                      <div>
                        <dt>Coarse frequency offset</dt>
                        <dd>
                          {receiver.dab?.coarseFrequencyOffsetHz == null
                            ? "—"
                            : `${receiver.dab.coarseFrequencyOffsetHz.toFixed(0)} Hz`}
                        </dd>
                      </div>
                      <div>
                        <dt>Valid FIC blocks</dt>
                        <dd>
                          {receiver.dab?.ficBlockCount ?? 0} /{" "}
                          {receiver.dab?.ficBlockAttempts ?? 0}
                        </dd>
                      </div>
                      <div>
                        <dt>FIC-bearing frames</dt>
                        <dd>
                          {receiver.dab?.ficFramesWithAny ?? 0} /{" "}
                          {receiver.dab?.ficFrameCount ?? 0} (
                          {receiver.dab?.ficCompleteFrames ?? 0} complete)
                        </dd>
                      </div>
                      <div>
                        <dt>FIBs per frame</dt>
                        <dd>
                          {receiver.dab?.ficSuccessHistogram
                            ?.map((count, valid) =>
                              count > 0 ? `${valid}:${count}` : "",
                            )
                            .filter(Boolean)
                            .join(" · ") || "—"}
                        </dd>
                      </div>
                      <div>
                        <dt>Valid FIBs by coding group</dt>
                        <dd>
                          {receiver.dab?.ficGroupBlocks?.join(" · ") || "—"}
                        </dd>
                      </div>
                      <div>
                        <dt>Decoder frequency correction</dt>
                        <dd>
                          {receiver.dab?.decoderCoarseCarrierOffsetHz ?? 0} Hz
                          coarse
                          {receiver.dab?.decoderCoarseCarrierLocked
                            ? " (locked)"
                            : ""}
                          ,{" "}
                          {receiver.dab?.decoderFineFrequencyCorrectionHz?.toFixed(
                            1,
                          ) ?? "0.0"}{" "}
                          Hz fine
                        </dd>
                      </div>
                      <div>
                        <dt>Decoder timing start</dt>
                        <dd>
                          {receiver.dab?.decoderTimingStartSamples ?? 0} samples
                        </dd>
                      </div>
                      <div>
                        <dt>Frame interval / missed frames</dt>
                        <dd>
                          {(
                            (receiver.dab?.frameIntervalSamples ?? 0) / 2048
                          ).toFixed(1)}{" "}
                          ms / {receiver.dab?.missedFrames ?? 0}
                        </dd>
                      </div>
                      <div>
                        <dt>OFDM/FEC processing (last / peak)</dt>
                        <dd>
                          {receiver.dab?.processingMs?.toFixed(1) ?? "0"} /{" "}
                          {receiver.dab?.maxProcessingMs?.toFixed(1) ?? "0"} ms
                          per 96 ms frame
                        </dd>
                      </div>
                      <div>
                        <dt>Q convention</dt>
                        <dd>{receiver.dab?.quadraturePolarity ?? "—"}</dd>
                      </div>
                      <div>
                        <dt>Synchronization losses</dt>
                        <dd>{receiver.dab?.synchronizationLosses ?? 0}</dd>
                      </div>
                      <div>
                        <dt>Selected service</dt>
                        <dd>
                          {receiver.dab?.serviceId == null
                            ? "—"
                            : `0x${receiver.dab.serviceId.toString(16).toUpperCase()}`}
                        </dd>
                      </div>
                      <div>
                        <dt>MSC subchannel</dt>
                        <dd>{receiver.dab?.subchannelId ?? "—"}</dd>
                      </div>
                      <div>
                        <dt>MSC logical frames</dt>
                        <dd>{receiver.dab?.logicalFrameCount ?? 0}</dd>
                      </div>
                      <div>
                        <dt>DAB+ superframes</dt>
                        <dd>{receiver.dab?.superframeCount ?? 0}</dd>
                      </div>
                      <div>
                        <dt>Superframe candidates</dt>
                        <dd>{receiver.dab?.superframeCandidateCount ?? 0}</dd>
                      </div>
                      <div>
                        <dt>RS-rejected candidates</dt>
                        <dd>{receiver.dab?.reedSolomonFailureCount ?? 0}</dd>
                      </div>
                      <div>
                        <dt>RS columns (last / best)</dt>
                        <dd>
                          {receiver.dab?.lastCorrectedRsColumns ?? 0} /{" "}
                          {receiver.dab?.bestCorrectedRsColumns ?? 0}
                        </dd>
                      </div>
                      <div>
                        <dt>Fire-code failures</dt>
                        <dd>{receiver.dab?.fireCodeFailureCount ?? 0}</dd>
                      </div>
                      <div>
                        <dt>Audio format</dt>
                        <dd>
                          {receiver.dab?.audioFormat
                            ? `DAB+ · ${receiver.dab.audioFormat.dacRate ? "48" : "32"} kHz · ${receiver.dab.audioFormat.stereo || receiver.dab.audioFormat.parametricStereo ? "Stereo" : "Mono"}${receiver.dab.audioFormat.sbr ? " · SBR" : ""}${receiver.dab.audioFormat.parametricStereo ? " · PS" : ""}`
                            : "Waiting for audio format…"}
                        </dd>
                      </div>
                      <div>
                        <dt>Browser audio decoder</dt>
                        <dd>
                          {receiver.dab?.audioDecoderMessage ??
                            "Waiting for validated audio"}
                        </dd>
                      </div>
                      <div>
                        <dt>Decoded PCM audio</dt>
                        <dd>
                          {receiver.dab?.decodedAudioSeconds?.toFixed(2) ??
                            "0.00"}{" "}
                          s
                          {receiver.dab?.pcmSampleRateHz
                            ? ` at ${receiver.dab.pcmSampleRateHz.toLocaleString()} Hz`
                            : ""}
                        </dd>
                      </div>
                      <div>
                        <dt>AAC access units</dt>
                        <dd>{receiver.dab?.accessUnitCount ?? 0}</dd>
                      </div>
                    </dl>
                    <p className="display-note">
                      The first available DAB+ station plays automatically. Use
                      the station selector above to change programmes. Legacy
                      MPEG Layer II DAB and encrypted services are not sent to
                      the HE-AAC output path.
                    </p>
                  </details>
                </>
              ) : mode === "ADS-B" ? (
                <>
                  <div className="target-table-wrap">
                    <table className="target-table">
                      <thead>
                        <tr>
                          <th>Aircraft</th>
                          <th>Altitude</th>
                          <th>Speed / track</th>
                          <th>Position</th>
                          <th>Messages</th>
                        </tr>
                      </thead>
                      <tbody>
                        {(receiver.adsb?.targets ?? [])
                          .slice(0, 50)
                          .map((target) => (
                            <tr key={target.id ?? target.icao}>
                              <td>
                                <strong>{target.callsign ?? "—"}</strong>
                                <small>{target.address ?? target.icao} · {target.addressType ?? "ICAO"} · {target.origin ?? "ADS-B"}</small>
                              </td>
                              <td>
                                {target.altitudeFt == null
                                  ? "—"
                                  : `${target.altitudeFt.toLocaleString()} ft`}
                              </td>
                              <td>
                                {target.groundSpeedKt == null
                                  ? "—"
                                  : `${target.groundSpeedKt.toFixed(0)} kt · ${target.trackDegrees?.toFixed(0) ?? "—"}°`}
                              </td>
                              <td>
                                {target.latitude == null
                                  ? "—"
                                  : `${target.latitude.toFixed(4)}, ${target.longitude?.toFixed(4)}`}
                              </td>
                              <td>{target.messages}</td>
                            </tr>
                          ))}
                      </tbody>
                    </table>
                  </div>
                  <button
                    type="button"
                    className="secondary"
                    disabled={!receiver.adsb?.targets.length}
                    onClick={() =>
                      downloadDecodedTargets(
                        "ADS-B",
                        receiver.adsb?.targets ?? [],
                      )
                    }
                  >
                    Export targets JSON
                  </button>
                  <details className="decoder-details">
                    <summary>Decoder details</summary>{" "}
                    <dl className="rds-grid">
                      <div>
                        <dt>Preamble candidates</dt>
                        <dd>{receiver.adsb?.preamblesDetected ?? 0}</dd>
                      </div>
                      <div>
                        <dt>CRC-valid Mode S</dt>
                        <dd>{receiver.adsb?.crcValidFrames ?? 0}</dd>
                      </div>
                      <div>
                        <dt>Supported DF17/DF18</dt>
                        <dd>{receiver.adsb?.validFrames ?? 0}</dd>
                      </div>
                      <div>
                        <dt>CRC-valid unsupported DF</dt>
                        <dd>{receiver.adsb?.unsupportedFrames ?? 0}</dd>
                      </div>
                      <div>
                        <dt>CRC failures</dt>
                        <dd>{receiver.adsb?.crcFailures ?? 0}</dd>
                      </div>
                      <div>
                        <dt>Ambiguous bit decisions</dt>
                        <dd>{receiver.adsb?.ambiguousFrames ?? 0}</dd>
                      </div>
                      <div>
                        <dt>Targets</dt>
                        <dd>{receiver.adsb?.targets.length ?? 0}</dd>
                      </div>
                    </dl>
                    <p className="display-note">
                      CRC-valid counts zero-remainder parity. Address- or
                      interrogator-overlaid Mode S replies cannot be
                      independently validated here.
                    </p>
                  </details>
                </>
              ) : mode === "AIS" ? (
                <>
                  <div className="target-table-wrap">
                    <table className="target-table">
                      <thead>
                        <tr>
                          <th>Vessel</th>
                          <th>Channel</th>
                          <th>Speed / course</th>
                          <th>Position</th>
                          <th>Messages</th>
                        </tr>
                      </thead>
                      <tbody>
                        {(receiver.ais?.targets ?? [])
                          .slice(0, 50)
                          .map((target) => (
                            <tr key={target.mmsi}>
                              <td>
                                <strong>{target.name ?? "—"}</strong>
                                <small>{target.callSign ?? target.mmsi}</small>
                              </td>
                              <td>{target.channel}</td>
                              <td>
                                {target.speedKnots == null
                                  ? "—"
                                  : `${target.speedKnots.toFixed(1)} kt · ${target.courseDegrees?.toFixed(1) ?? "—"}°`}
                              </td>
                              <td>
                                {target.latitude == null
                                  ? "—"
                                  : `${target.latitude.toFixed(4)}, ${target.longitude?.toFixed(4)}`}
                              </td>
                              <td>{target.messages}</td>
                            </tr>
                          ))}
                      </tbody>
                    </table>
                  </div>
                  <button
                    type="button"
                    className="secondary"
                    disabled={!receiver.ais?.targets.length}
                    onClick={() =>
                      downloadDecodedTargets("AIS", receiver.ais?.targets ?? [])
                    }
                  >
                    Export targets JSON
                  </button>
                  <details className="decoder-details">
                    <summary>Decoder details</summary>{" "}
                    <dl className="rds-grid">
                      <div>
                        <dt>AIS 1 frames</dt>
                        <dd>{receiver.ais?.channel1Frames ?? 0}</dd>
                      </div>
                      <div>
                        <dt>AIS 2 frames</dt>
                        <dd>{receiver.ais?.channel2Frames ?? 0}</dd>
                      </div>
                      <div>
                        <dt>Rejected</dt>
                        <dd>{receiver.ais?.rejectedFrames ?? 0}</dd>
                      </div>
                      <div>
                        <dt>Vessels</dt>
                        <dd>{receiver.ais?.targets.length ?? 0}</dd>
                      </div>
                    </dl>
                  </details>
                </>
              ) : mode !== "WBFM" ? (
                <p className="rds-empty">
                  RDS decoding is available only in WBFM. Audio remains
                  available for the selected mode.
                </p>
              ) : !receiver.rds?.validGroups ? (
                <p className="rds-empty">
                  No validated station data decoded yet.
                </p>
              ) : (
                <dl className="rds-grid">
                  <div>
                    <dt>PI identifier</dt>
                    <dd>{receiver.rds.pi ?? "—"}</dd>
                  </div>
                  <div>
                    <dt>Programme Service</dt>
                    <dd>
                      {receiver.rds.programmeService ??
                        "Waiting for all PS segments…"}
                    </dd>
                  </div>
                  <div className="rds-text">
                    <dt>RadioText</dt>
                    <dd>
                      {receiver.rds.radioText ?? "Waiting for RadioText…"}
                    </dd>
                  </div>
                </dl>
              )}
              {mode === "WBFM" && (
                <details className="decoder-details">
                  <summary>Decoder details</summary>
                  <p className="display-note">
                    Text appears only after CRC and block-offset validation.
                    Retuning, changing station PI, or leaving WBFM clears prior
                    data.
                  </p>
                </details>
              )}
            </div>
          )}
      </div>
    </section>
  );
}

export function ReceiverDecodePanel(props: {
  controller: ReceiverController;
  source: SourceKind;
  mode: ReceiverMode;
  volume: number;
  active: boolean;
  onOpenDecoder?: () => void;
}) {
  const { receiver, presenting } = useVisibleReceiver(props.controller, props.active);
  return presenting ? <DecodedResults {...props} receiver={receiver} /> : null;
}

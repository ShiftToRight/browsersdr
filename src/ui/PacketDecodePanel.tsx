import type { ReceiverSnapshot } from "../radio/receiverController";
import { packetDecoderExport } from "../radio/packetExport";
import type { Ax25Address, AprsWeather } from "../aprs/types";
import type { DigitalProvenance } from "../digital";

function address(a: Ax25Address): string {
  return `${a.callsign}${a.ssid ? `-${a.ssid}` : ""}${a.repeated ? "*" : ""}`;
}
function lastHeard(p: DigitalProvenance): string {
  return `sample ${p.lastInputSampleIndex.toLocaleString()} · generation ${p.generation} · ${(p.lastInputSampleIndex / p.actualInputSampleRateHz).toFixed(2)} s`;
}
function weather(w: AprsWeather): string {
  const units: Record<keyof AprsWeather, string> = {
    windDirectionDegrees: "°",
    windSpeedMetersPerSecond: "m/s",
    windGustMetersPerSecond: "m/s",
    temperatureCelsius: "°C",
    rainLastHourMillimeters: "mm/h",
    rainLast24HoursMillimeters: "mm/24 h",
    rainSinceMidnightMillimeters: "mm since midnight",
    humidityPercent: "%",
    pressureHectopascals: "hPa",
    luminosityWattsPerSquareMeter: "W/m²",
  };
  return Object.entries(w)
    .map(
      ([key, value]) =>
        `${key.replace(/([A-Z])/g, " $1")}: ${value} ${units[key as keyof AprsWeather]}`,
    )
    .join(" · ");
}
function download(receiver: ReceiverSnapshot): void {
  const data = packetDecoderExport(receiver);
  if (!data) return;
  const url = URL.createObjectURL(
    new Blob(
      [
        JSON.stringify(
          data,
          (_key, value) =>
            value instanceof Uint8Array ? Array.from(value) : value,
          2,
        ),
      ],
      { type: "application/json" },
    ),
  );
  const link = document.createElement("a");
  link.href = url;
  link.download = `browsersdr-${data.settings.mode.toLowerCase()}-${Date.now()}.json`;
  link.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

export function PacketDecodePanel({
  receiver,
  mode,
}: {
  receiver: ReceiverSnapshot;
  mode: "APRS" | "RS41";
}) {
  const aprs = mode === "APRS";
  const state = aprs ? receiver.aprs : receiver.rs41;
  const worker = aprs ? receiver.aprsWorker : receiver.rs41Worker;
  return (
    <div className="packet-decode-panel">
      <p className="support-copy">
        {aprs
          ? "Receive-only 1200-baud Bell-202 · AX.25 FCS required. Positions are reported by the packet; unsupported payloads remain visible."
          : "Unencrypted RS41 only · Reed–Solomon and individual sub-block CRCs. Height is above the WGS-84 ellipsoid; calibrated PTU and encrypted frames are unsupported."}
      </p>
      <div className="target-table-wrap">
        <table className="target-table">
          <thead>
            <tr>
              <th>{aprs ? "Station / path" : "Sonde / frame"}</th>
              <th>Reported position</th>
              <th>{aprs ? "Weather / status" : "Velocity / integrity"}</th>
              <th>Last heard</th>
            </tr>
          </thead>
          <tbody>
            {aprs
              ? receiver.aprs?.stations.map((station) => (
                  <tr key={station.key}>
                    <td>
                      <strong>{address(station.source)}</strong>
                      <small>
                        To {address(station.destination)} ·{" "}
                        {station.path.map(address).join(", ") || "direct"} ·{" "}
                        {station.packets} packet(s)
                      </small>
                    </td>
                    <td>
                      {station.position ? (
                        <>
                          {station.position.latitudeDegrees.toFixed(5)},{" "}
                          {station.position.longitudeDegrees.toFixed(5)}
                          <small>
                            Ambiguity: {station.position.ambiguityDigits}{" "}
                            digit(s) · precision{" "}
                            {station.position.precisionMeters === null
                              ? "unknown"
                              : `~${station.position.precisionMeters.toFixed(0)} m`}
                          </small>
                          <small>
                            Latest retained position; later status packets may
                            have no fix.
                          </small>
                        </>
                      ) : (
                        "Unknown"
                      )}
                      {station.altitudeMeters !== undefined && (
                        <small>
                          {station.altitudeMeters.toFixed(0)} m altitude
                        </small>
                      )}
                    </td>
                    <td>
                      {station.statusText || "—"}
                      {station.weather && (
                        <small>{weather(station.weather)}</small>
                      )}
                    </td>
                    <td>
                      {lastHeard(station.lastHeard)}
                      <small>AX.25 FCS passed</small>
                    </td>
                  </tr>
                ))
              : receiver.rs41?.sondes.map((sonde) => {
                  const frame = receiver.rs41?.recentFrames
                    .slice()
                    .reverse()
                    .find(
                      (frame) =>
                        frame.sondeId === sonde.sondeId &&
                        frame.fecStatus !== "rejected",
                    );
                  const fix = sonde.track.at(-1);
                  return (
                    <tr key={sonde.sondeId}>
                      <td>
                        <strong>{sonde.sondeId}</strong>
                        <small>
                          Frame {sonde.lastFrameCounter} · {sonde.track.length}{" "}
                          retained track point(s)
                        </small>
                        {sonde.batteryVolts !== undefined && (
                          <small>{sonde.batteryVolts.toFixed(1)} V</small>
                        )}
                      </td>
                      <td>
                        {sonde.position ? (
                          <>
                            {sonde.position.latitudeDegrees.toFixed(5)},{" "}
                            {sonde.position.longitudeDegrees.toFixed(5)}
                            <small>
                              {sonde.position.altitudeMeters.toFixed(1)} m
                              ellipsoidal height
                            </small>
                            <small>
                              {fix
                                ? `Last valid GPS-POS: ${lastHeard(fix.provenance)}`
                                : "Retained position; original fix history expired"}
                            </small>
                          </>
                        ) : (
                          "Unknown / no valid GPS-POS"
                        )}
                      </td>
                      <td>
                        {sonde.position && (
                          <>
                            {sonde.position.horizontalSpeedMetersPerSecond.toFixed(
                              1,
                            )}{" "}
                            m/s horizontal ·{" "}
                            {sonde.position.upVelocityMetersPerSecond.toFixed(
                              1,
                            )}{" "}
                            m/s vertical
                          </>
                        )}
                        <small>
                          {frame
                            ? `${frame.fecStatus} · ${frame.correctedErrors} corrected symbol(s)`
                            : "Integrity history expired"}
                        </small>
                      </td>
                      <td>
                        {lastHeard(sonde.lastHeard)}
                        {sonde.gpsTime && (
                          <small>
                            GPS week {sonde.gpsTime.week} ·{" "}
                            {sonde.gpsTime.timeOfWeekMilliseconds} ms (not UTC)
                          </small>
                        )}
                      </td>
                    </tr>
                  );
                })}
            {!(aprs
              ? receiver.aprs?.stations.length
              : receiver.rs41?.sondes.length) && (
              <tr>
                <td colSpan={4}>
                  {aprs
                    ? "No FCS-valid APRS stations yet. Tune a 1200-baud VHF APRS channel or load a compatible I/Q recording."
                    : "No integrity-valid RS41 sondes yet. Tune a radiosonde channel or load a compatible I/Q recording."}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      <details className="decoder-details">
        <summary>
          {aprs
            ? "Packets & decoder details"
            : "Frames, track & decoder details"}
        </summary>
        <p className="support-copy">
          Showing up to 32 stations/sondes and 32 recent records, with up to 128
          total track points. Last heard and expiry use decoder input samples,
          including known gaps; they do not imply UTC reception time. Replay EOF
          preserves the final display. Stop, a new tune, mode or session clears
          it. Dropped input blocks: {worker?.droppedInputBlocks ?? 0} · queue:{" "}
          {worker?.queuedBlocks ?? 0}/{worker?.queueCapacityBlocks ?? 8}.
        </p>
        <dl className="metrics-grid">
          {Object.entries(state?.counters ?? {}).map(([name, value]) => (
            <div key={name}>
              <dt>{name.replace(/([A-Z])/g, " $1")}</dt>
              <dd>{value}</dd>
            </div>
          ))}
        </dl>
        {aprs ? (
          <ul className="packet-record-list">
            {receiver.aprs?.recentPackets
              .slice()
              .reverse()
              .map((packet) => (
                <li key={packet.sequence}>
                  <strong>
                    {address(packet.frame.source)} →{" "}
                    {address(packet.frame.destination)}
                  </strong>{" "}
                  · {packet.payload.kind}
                  <small>
                    Path:{" "}
                    {packet.frame.path.map(address).join(", ") || "direct"} ·
                    FCS passed · {lastHeard(packet.provenance)}
                  </small>
                  <p>{new TextDecoder().decode(packet.frame.information)}</p>
                </li>
              ))}
          </ul>
        ) : (
          <>
            <ul className="packet-record-list">
              {receiver.rs41?.recentFrames
                .slice()
                .reverse()
                .map((frame, index) => (
                  <li key={index}>
                    <strong>{frame.sondeId ?? "Unknown identity"}</strong> ·{" "}
                    {frame.variant} · frame {frame.frameCounter ?? "unknown"} ·
                    FEC {frame.fecStatus} ({frame.correctedErrors} corrections)
                    <small>
                      {Object.entries(frame.subblockIntegrity)
                        .map(
                          ([name, passed]) =>
                            `${name}: ${passed ? "CRC passed" : "absent / failed"}`,
                        )
                        .join(" · ")}
                    </small>
                    <small>{lastHeard(frame.provenance)}</small>
                  </li>
                ))}
            </ul>
            {receiver.rs41?.sondes.map((sonde) => (
              <details key={sonde.sondeId}>
                <summary>
                  {sonde.sondeId} track ({sonde.track.length} retained)
                </summary>
                <ol className="packet-record-list">
                  {sonde.track.map((point, index) => (
                    <li key={index}>
                      Frame {point.frameCounter} ·{" "}
                      {point.position.latitudeDegrees.toFixed(5)},{" "}
                      {point.position.longitudeDegrees.toFixed(5)} ·{" "}
                      {point.position.altitudeMeters.toFixed(1)} m ellipsoidal ·{" "}
                      {point.fecStatus}
                    </li>
                  ))}
                </ol>
              </details>
            ))}
          </>
        )}
      </details>
      <button
        type="button"
        className="secondary-button"
        disabled={!state}
        onClick={() => download(receiver)}
      >
        {aprs ? "Export APRS data (JSON)" : "Export RS41 data (JSON)"}
      </button>
    </div>
  );
}

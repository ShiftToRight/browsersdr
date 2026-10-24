import { useSyncExternalStore } from "react";
import type { ReceiverController } from "../radio/receiverController";

export function DabStationControl({
  controller,
}: {
  controller: ReceiverController;
}) {
  const receiver = useSyncExternalStore(
    controller.subscribe,
    controller.getSnapshot,
  );
  const dab = receiver.dab;
  return (
    <label>
      DAB station
      <select
        aria-label="DAB station"
        disabled={
          receiver.lifecycle !== "running" ||
          !dab?.stations?.some((station) => station.playable)
        }
        value={
          dab?.serviceId == null ? "" : `${dab.serviceId}:${dab.subchannelId}`
        }
        onChange={(event) =>
          controller.selectDabService(event.currentTarget.value)
        }
      >
        {dab?.serviceId == null && (
          <option value="">
            {receiver.lifecycle === "running"
              ? "Discovering stations…"
              : "Start receiving to find stations"}
          </option>
        )}
        {dab?.stations?.map((station) => (
          <option
            key={station.key}
            value={station.key}
            disabled={!station.playable}
          >
            {station.label ||
              `Service 0x${station.serviceId.toString(16).toUpperCase()}`}
            {!station.dabPlus
              ? " · DAB (unsupported)"
              : !station.playable
                ? " · waiting for configuration"
                : ""}
          </option>
        ))}
      </select>
      {dab?.ensemble?.label && <small>{dab.ensemble.label}</small>}
    </label>
  );
}

export function FmStationSummary({
  controller,
}: {
  controller: ReceiverController;
}) {
  const receiver = useSyncExternalStore(
    controller.subscribe,
    controller.getSnapshot,
  );
  const current = receiver.lifecycle === "running" && receiver.session?.mode === "WBFM" && receiver.session.source !== "synthetic";
  const name = current ? receiver.rds?.programmeService : undefined;
  return <div className="channel-programme" aria-label="FM station" title={name ? `Decoded Programme Service: ${name}. This does not establish transmitter identity.` : "No validated Programme Service text yet"}>
    <small>RDS</small><strong>{name || "No station text yet"}</strong>
  </div>;
}

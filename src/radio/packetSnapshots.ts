import type { AprsSnapshot } from "../aprs/types";
import type { Rs41Snapshot } from "../rs41/types";

// The core retains larger histories; publications fit the shared 256 KiB result ceiling.
export function boundedAprsSnapshot(snapshot: AprsSnapshot): AprsSnapshot {
  return {
    ...snapshot,
    stations: snapshot.stations
      .slice()
      .sort(
        (a, b) =>
          b.lastHeard.lastInputSampleIndex - a.lastHeard.lastInputSampleIndex,
      )
      .slice(0, 32),
    recentPackets: snapshot.recentPackets.slice(-32),
  };
}
export function boundedRs41Snapshot(snapshot: Rs41Snapshot): Rs41Snapshot {
  return {
    ...snapshot,
    recentFrames: snapshot.recentFrames.slice(-32),
    sondes: snapshot.sondes.map((sonde) => ({
      ...sonde,
      track: sonde.track.slice(
        -Math.max(1, Math.floor(128 / Math.max(1, snapshot.sondes.length))),
      ),
    })),
  };
}

/** Local decoder-clock fixes. Reset with the owning decoder; never infer UTC. */
export interface TargetTrackPoint {
  latitude: number;
  longitude: number;
  timeMs: number;
}

export const TARGET_LIMIT = 50;
export const TARGET_TRACK_LIMIT = 32;

export function appendTargetFix(
  track: readonly TargetTrackPoint[],
  latitude: number | null,
  longitude: number | null,
  timeMs: number,
): readonly TargetTrackPoint[] {
  if (
    latitude === null ||
    longitude === null ||
    !Number.isFinite(latitude) ||
    !Number.isFinite(longitude) ||
    Math.abs(latitude) > 90 ||
    Math.abs(longitude) > 180 ||
    !Number.isFinite(timeMs)
  )
    return track;
  const previous = track.at(-1);
  if (
    previous &&
    (timeMs < previous.timeMs ||
      (latitude === previous.latitude && longitude === previous.longitude))
  )
    return track;
  return [
    ...track.slice(-(TARGET_TRACK_LIMIT - 1)),
    { latitude, longitude, timeMs },
  ];
}

export function boundTargets<K, T extends { lastSeenMs: number }>(
  targets: Map<K, T>,
): void {
  if (targets.size <= TARGET_LIMIT) return;
  const oldest = [...targets.entries()].sort(
    (a, b) => a[1].lastSeenMs - b[1].lastSeenMs,
  );
  for (const [key] of oldest.slice(0, targets.size - TARGET_LIMIT))
    targets.delete(key);
}

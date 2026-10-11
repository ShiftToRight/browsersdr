import { expect, it } from "vitest";
import {
  appendTargetFix,
  boundTargets,
  TARGET_TRACK_LIMIT,
  type TargetTrackPoint,
} from "./targetTrack";

it("bounds distinct fixes without mutating published history or accepting invalid/backward fixes", () => {
  let track: readonly TargetTrackPoint[] = [];
  for (let i = 0; i < 100; i++)
    track = appendTargetFix(track, 50 + i / 1000, 13, i);
  expect(track).toHaveLength(TARGET_TRACK_LIMIT);
  expect(track[0]?.timeMs).toBe(68);
  const held = track;
  for (const [lat, lon, time] of [
    [null, 13, 101],
    [91, 13, 101],
    [50, 181, 101],
    [NaN, 13, 101],
    [50, 13, 20],
    [50.099, 13, 101],
  ] as const)
    expect(appendTargetFix(track, lat, lon, time)).toBe(track);
  track = appendTargetFix(track, 51, 14, 102);
  expect(held.at(-1)?.timeMs).toBe(99);
  expect(track.at(-1)?.timeMs).toBe(102);
});

it("bounds retained targets by decoder-clock last reception", () => {
  const targets = new Map(
    Array.from({ length: 51 }, (_, i) => [i, { lastSeenMs: i }]),
  );
  boundTargets(targets);
  expect(targets.size).toBe(50);
  expect(targets.has(0)).toBe(false);
  expect(targets.has(50)).toBe(true);
});

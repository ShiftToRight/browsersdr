import { expect, it } from "vitest";
import { aircraftCategory, targetTrackPaths } from "./targetMapPresentation";
import { computeMapViewport } from "./positionMapGeometry";

it("uses category set A for rotorcraft/size symbols and keeps unsupported categories generic", () => {
  expect(aircraftCategory("A7").symbol).toBe("helicopter");
  for (const category of ["A1", "A2"])
    expect(aircraftCategory(category).symbol).toBe("small-plane");
  for (const category of ["A3", "A4", "A5"])
    expect(aircraftCategory(category).symbol).toBe("large-plane");
  for (const category of [null, "A0", "B7", "C7", "D7", "B1", "A6"])
    expect(aircraftCategory(category).symbol).toBe("generic");
  expect(aircraftCategory("B7").label).toContain("Space");
});

it("splits trails across reception gaps, invalid fixes, backward clocks and the viewport seam", () => {
  const viewport = computeMapViewport([]);
  const fix = (longitude: number, timeMs: number) => ({
    latitude: 52,
    longitude,
    timeMs,
  });
  const paths = targetTrackPaths(
    [
      fix(13, 0),
      fix(14, 1),
      fix(15, 50_000),
      fix(16, 50_001),
      fix(NaN, 50_002),
      fix(17, 50_003),
      fix(18, 50_004),
    ],
    viewport,
    30_000,
  );
  expect(paths).toHaveLength(3);
  expect(
    targetTrackPaths([fix(179, 0), fix(-179, 1)], viewport, 30_000),
  ).toEqual([]);
  const local = computeMapViewport([
    { ...fix(179, 0), label: "east" },
    { ...fix(-179, 1), label: "west" },
  ]);
  expect(
    targetTrackPaths([fix(179, 0), fix(-179, 1)], local, 30_000),
  ).toHaveLength(1);
  expect(targetTrackPaths([fix(13, 2), fix(14, 1)], viewport, 30_000)).toEqual(
    [],
  );
});

import { expect, it } from "vitest";
import {
  computeMapViewport,
  mapViewportForSurface,
} from "./positionMapGeometry";
import { mapRangeRings } from "./mapRangeRings";

it("uses bounded geodesic distance rings with correct northward distance, including high latitudes/dateline", () => {
  for (const site of [
    { latitude: 52.5, longitude: 13.4 },
    { latitude: 85, longitude: 179.9 },
  ]) {
    const viewport = mapViewportForSurface(
      computeMapViewport([{ ...site, label: "Receiver" }]),
      1200,
      400,
    );
    const rings = mapRangeRings(site, viewport);
    expect(rings).toHaveLength(3);
    expect(rings.map((r) => r.km)).toEqual([
      rings[0]!.km,
      rings[0]!.km * 2,
      rings[0]!.km * 3,
    ]);
    for (const ring of rings) {
      expect(ring.path).not.toMatch(/NaN|Infinity/);
      expect(ring.labelY).toBeGreaterThanOrEqual(viewport.y);
      expect(ring.path.match(/[ML]/g)).toHaveLength(73);
      const northLatitude = 90 - ring.labelY / 2;
      expect(
        (((northLatitude - site.latitude) * Math.PI) / 180) * 6371,
      ).toBeCloseTo(ring.km, 5);
    }
  }
});

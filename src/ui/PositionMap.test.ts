import { describe, expect, it } from "vitest";
import {
  computeMapViewport,
  latitudeToY,
  mapViewportForSurface,
  mapViewportInReference,
  panMapViewport,
  xForViewport,
} from "./positionMapGeometry";

describe("computeMapViewport", () => {
  it("uses the global overview without positioned targets", () => {
    expect(computeMapViewport([])).toMatchObject({
      x: 0,
      y: 0,
      width: 720,
      height: 360,
      zoom: 0,
      longitudeScale: 1,
      local: false,
    });
  });

  it("frames a single target with at least a 50 km radius of context", () => {
    const viewport = computeMapViewport([
      { latitude: 48.137, longitude: 11.575, label: "Munich" },
    ]);

    expect(viewport.local).toBe(true);
    expect(viewport.centerLongitude).toBeCloseTo(11.575);
    expect(viewport.longitudeScale).toBeCloseTo(
      Math.cos((48.137 * Math.PI) / 180),
    );
    expect(viewport.height / 2).toBeCloseTo(100 / 111.32, 2);
    expect(viewport.width / viewport.height).toBe(2);
    expect(viewport.zoom).toBeGreaterThan(7);
  });

  it("expands to contain separated targets while preserving map aspect", () => {
    const viewport = computeMapViewport([
      { latitude: 48.137, longitude: 11.575, label: "Munich" },
      { latitude: 52.52, longitude: 13.405, label: "Berlin" },
    ]);

    expect(viewport.width / viewport.height).toBe(2);
    expect(viewport.x).toBeLessThan(xForViewport(11.575, viewport));
    expect(viewport.x + viewport.width).toBeGreaterThan(
      xForViewport(13.405, viewport),
    );
    expect(viewport.y).toBeLessThan((90 - 52.52) * 2);
    expect(viewport.y + viewport.height).toBeGreaterThan((90 - 48.137) * 2);
  });

  it("uses equal local map distances at Berlin's latitude", () => {
    const latitude = 52.52;
    const longitude = 13.405;
    const viewport = computeMapViewport([
      { latitude, longitude, label: "Berlin" },
    ]);
    const latitudeDegreesForTenKm = 10 / 111.32;
    const longitudeDegreesForTenKm =
      latitudeDegreesForTenKm / Math.cos((latitude * Math.PI) / 180);

    const horizontalDistance =
      xForViewport(longitude + longitudeDegreesForTenKm, viewport) -
      xForViewport(longitude, viewport);
    const verticalDistance =
      latitudeToY(latitude) - latitudeToY(latitude + latitudeDegreesForTenKm);

    expect(horizontalDistance).toBeCloseTo(verticalDistance, 8);
  });
});

describe("panning", () => {
  it("moves the view while preserving target/bitmap alignment across the longitude seam", () => {
    const original = computeMapViewport([
      { latitude: 52, longitude: 179.9, label: "Aircraft" },
    ]);
    const moved = panMapViewport(original, 1, 0.25);
    expect(moved.centerLongitude).toBeLessThan(-179);
    const reference = mapViewportInReference(moved, original);
    expect(reference.x - original.x).toBeCloseTo(1);
    expect(moved.y - original.y).toBeCloseTo(0.25);
    const before = xForViewport(179.9, original) - original.x;
    const after = xForViewport(179.9, moved) - moved.x;
    expect(after - before).toBeCloseTo(-1);
    expect(moved.width).toBe(original.width);
    expect(moved.height).toBe(original.height);
  });
  it("stops vertical panning at the poles", () => {
    const original = computeMapViewport([
      { latitude: 52, longitude: 13, label: "Aircraft" },
    ]);
    expect(panMapViewport(original, 0, -1000).y).toBe(0);
    expect(panMapViewport(original, 0, 1000).y + original.height).toBe(360);
  });
});

describe("mapViewportForSurface", () => {
  it("fills wide and narrow surfaces by adding context without clipping the fitted bounds", () => {
    const original = computeMapViewport([
      { latitude: 52.52, longitude: 13.405, label: "Berlin" },
      { latitude: 48.137, longitude: 11.575, label: "Munich" },
    ]);
    for (const [width, height] of [
      [1646, 430],
      [320, 360],
    ]) {
      const fitted = mapViewportForSurface(original, width!, height!);
      expect(fitted.width / fitted.height).toBeCloseTo(width! / height!);
      expect(fitted.x).toBeLessThanOrEqual(original.x);
      expect(fitted.y).toBeLessThanOrEqual(original.y);
      expect(fitted.x + fitted.width).toBeGreaterThanOrEqual(
        original.x + original.width,
      );
      expect(fitted.y + fitted.height).toBeGreaterThanOrEqual(
        original.y + original.height,
      );
      expect(fitted.longitudeScale).toBe(original.longitudeScale);
    }
  });
});

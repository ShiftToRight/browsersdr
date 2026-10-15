import { describe, expect, it } from "vitest";
import {
  computeMapViewport,
  latitudeToY,
  mapViewportForSurface,
  mapViewportInReference,
  panMapViewport,
  xForViewport,
  zoomMapViewport,
  boundedMapPixels,
  mapRasterPlan,
  mapViewportContains,
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

describe("zoom and raster resolution", () => {
  it("zooms around the geographic center, bounds levels, and preserves seam alignment", () => {
    const initial = computeMapViewport([
      { latitude: 52, longitude: 179.8, label: "Target" },
    ]);
    const close = zoomMapViewport(initial, 1);
    expect(close.width).toBeCloseTo(initial.width / 2);
    expect(close.height).toBeCloseTo(initial.height / 2);
    expect(close.x + close.width / 2).toBeCloseTo(
      initial.x + initial.width / 2,
    );
    expect(close.y + close.height / 2).toBeCloseTo(
      initial.y + initial.height / 2,
    );
    expect(zoomMapViewport(initial, 100).zoom).toBe(12);
    expect(zoomMapViewport(initial, -100).zoom).toBe(0);
    const region = mapRasterPlan(close, 1440, 720, 2);
    expect(mapViewportContains(region.viewport, close)).toBe(true);
    expect(
      mapViewportContains(
        region.viewport,
        panMapViewport(close, close.width, 0),
      ),
    ).toBe(false);
  });

  it("uses visible-map pixels without exceeding raster/front memory on desktop, phone or high DPI", () => {
    const viewport = computeMapViewport([
      { latitude: 52, longitude: 13, label: "Target" },
    ]);
    for (const [width, height, dpr] of [
      [1440, 600, 1],
      [390, 600, 3],
      [3840, 2160, 2],
    ]) {
      const plan = mapRasterPlan(viewport, width!, height!, dpr!);
      const front = boundedMapPixels(width!, height!, dpr!, 1024 * 1024);
      expect(plan.pixels.width * plan.pixels.height * 4).toBeLessThanOrEqual(
        8 * 1024 * 1024,
      );
      expect(front.width * front.height * 4).toBeLessThanOrEqual(
        4 * 1024 * 1024,
      );
      expect(plan.pixels.width / plan.pixels.height).toBeCloseTo(
        width! / height!,
        1,
      );
    }
    const desktop = mapRasterPlan(viewport, 1440, 600, 1);
    expect(desktop.pixels.width / 1.25).toBe(1440);
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
  it("keeps a zoomed-out world aligned with the surface aspect ratio", () => {
    const world = zoomMapViewport(
      computeMapViewport([{ latitude: 52, longitude: 13, label: "Target" }]),
      -100,
    );
    for (const [width, height] of [
      [1440, 600],
      [390, 600],
    ]) {
      const fitted = mapViewportForSurface(world, width!, height!);
      expect(fitted.width / fitted.height).toBeCloseTo(width! / height!);
      expect(fitted.x + fitted.width / 2).toBeCloseTo(
        world.x + world.width / 2,
      );
    }
  });
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

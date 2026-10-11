import type { TargetTrackPoint } from "../digital/targetTrack";
import {
  latitudeToY,
  xForViewport,
  type MapViewport,
} from "./positionMapGeometry";

export type TargetSymbol =
  "helicopter" | "small-plane" | "large-plane" | "vessel" | "generic";
export interface TargetMapPresentation {
  symbol: TargetSymbol;
  categoryLabel: string;
  direction: number | null;
  track: readonly TargetTrackPoint[];
  maximumGapMs: number;
}

const CATEGORY_LABELS: Record<string, string> = {
  A1: "Light aircraft",
  A2: "Small aircraft",
  A3: "Large aircraft",
  A4: "High-vortex aircraft",
  A5: "Heavy aircraft",
  A6: "High-performance aircraft",
  A7: "Rotorcraft",
  B1: "Glider / sailplane",
  B2: "Lighter-than-air",
  B3: "Parachutist / skydiver",
  B4: "Ultralight / hang glider / paraglider",
  B6: "Unmanned aerial vehicle",
  B7: "Space / trans-atmospheric vehicle",
  C1: "Surface emergency vehicle",
  C2: "Surface service vehicle",
  C3: "Point obstacle",
  C4: "Cluster obstacle",
  C5: "Line obstacle",
};

export function aircraftCategory(category?: string | null): {
  symbol: TargetSymbol;
  label: string;
} {
  return {
    symbol:
      category === "A7"
        ? "helicopter"
        : category === "A1" || category === "A2"
          ? "small-plane"
          : category === "A3" || category === "A4" || category === "A5"
            ? "large-plane"
            : "generic",
    label:
      category && CATEGORY_LABELS[category]
        ? `${CATEGORY_LABELS[category]} · ${category}`
        : category
          ? `Unknown / unspecified category · ${category}`
          : "Unknown",
  };
}

/** Split instead of drawing across missing reception or the map's longitude seam. */
export function targetTrackPaths(
  track: readonly TargetTrackPoint[],
  viewport: MapViewport,
  maximumGapMs: number,
): string[] {
  const paths: string[] = [];
  let segment: string[] = [];
  let previous: TargetTrackPoint | undefined;
  let previousX = 0;
  const finish = () => {
    if (segment.length > 1) paths.push(segment.join(" "));
    segment = [];
  };
  for (const point of track) {
    if (
      !Number.isFinite(point.latitude) ||
      !Number.isFinite(point.longitude) ||
      Math.abs(point.latitude) > 90 ||
      Math.abs(point.longitude) > 180 ||
      !Number.isFinite(point.timeMs)
    ) {
      finish();
      previous = undefined;
      continue;
    }
    const x = xForViewport(point.longitude, viewport);
    if (
      previous &&
      (point.timeMs < previous.timeMs ||
        point.timeMs - previous.timeMs > maximumGapMs ||
        Math.abs(x - previousX) > 360 * viewport.longitudeScale)
    )
      finish();
    segment.push(
      `${segment.length ? "L" : "M"}${x},${latitudeToY(point.latitude)}`,
    );
    previous = point;
    previousX = x;
  }
  finish();
  return paths;
}

// Original silhouettes, facing north; ground track/course is orientation, not aircraft heading.
export const TARGET_SYMBOL_PATHS: Record<
  Exclude<TargetSymbol, "generic">,
  string
> = {
  "small-plane":
    "M0 -10 L2 -3 L9 1 L9 3 L2 1 L2 7 L5 9 L5 10 L0 8 L-5 10 L-5 9 L-2 7 L-2 1 L-9 3 L-9 1 L-2 -3 Z",
  "large-plane":
    "M0 -12 Q3 -11 3 -5 L12 2 L12 5 L3 2 L2 8 L6 10 L6 12 L0 10 L-6 12 L-6 10 L-2 8 L-3 2 L-12 5 L-12 2 L-3 -5 Q-3 -11 0 -12 Z",
  helicopter:
    "M-2 -3 Q-4 -7 0 -8 Q4 -7 2 -3 L1 7 L4 8 L4 10 L-4 10 L-4 8 L-1 7 Z M-10 -2 L-10 -4 L10 -4 L10 -2 Z M-1 -12 L1 -12 L1 5 L-1 5 Z",
  vessel: "M0 -10 L5 -3 L5 8 L-5 8 L-5 -3 Z",
};

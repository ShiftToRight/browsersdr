import {
  latitudeToY,
  xForViewport,
  type MapViewport,
} from "./positionMapGeometry";

/** Spherical WGS84-context distances, not RF coverage or calibrated ranging. */
export function mapRangeRings(
  site: { latitude: number; longitude: number },
  viewport: MapViewport,
) {
  const spanKm = (Math.min(viewport.width, viewport.height) / 2) * 111.2;
  const step =
    [1, 2, 5, 10, 20, 50, 100, 200, 500, 1000]
      .filter((km) => km <= spanKm / 6)
      .at(-1) ?? 1;
  return [step, step * 2, step * 3].map((km) => {
    const lat = (site.latitude * Math.PI) / 180,
      lon = (site.longitude * Math.PI) / 180,
      distance = km / 6371;
    const points = Array.from({ length: 73 }, (_, n) => {
      const bearing = (n * Math.PI) / 36;
      const y = Math.asin(
        Math.max(
          -1,
          Math.min(
            1,
            Math.sin(lat) * Math.cos(distance) +
              Math.cos(lat) * Math.sin(distance) * Math.cos(bearing),
          ),
        ),
      );
      const x =
        lon +
        Math.atan2(
          Math.sin(bearing) * Math.sin(distance) * Math.cos(lat),
          Math.cos(distance) - Math.sin(lat) * Math.sin(y),
        );
      return {
        x: xForViewport((x * 180) / Math.PI, viewport),
        y: latitudeToY((y * 180) / Math.PI),
      };
    });
    return {
      km,
      labelX: points[0]!.x,
      labelY: points[0]!.y,
      path: points
        .map(
          (p, n) =>
            `${n === 0 || Math.abs(p.x - points[n - 1]!.x) > viewport.width / 2 ? "M" : "L"}${p.x.toFixed(5)},${p.y.toFixed(5)}`,
        )
        .join(" "),
    };
  });
}

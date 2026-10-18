import { longitudeToX, type MapViewport } from "./positionMapGeometry";

// The bundled layers contain only groups and paths. Keep parsed native paths,
// rather than reparsing all world coordinates for every regional zoom raster.
interface VectorPath {
  path: Path2D;
  fill: string;
  rule: CanvasFillRule;
  stroke: string;
  width: number;
  dashed: boolean;
}
const vectors = new Map<string, readonly VectorPath[] | null>();
export const MAP_COLORS: Readonly<Record<string, string>> = Object.freeze({
  "#07141b": "#091c28",
  "#102c35": "#244a58",
  "#315968": "#83b4c5",
  "#294d5a": "#75a7bb",
  "#266071": "#6eb0cb",
  "#4a7180": "#c0d5df",
  "#355966": "#8fb0c2",
});
const attributes = new Set([
  "d",
  "id",
  "fill",
  "fill-rule",
  "stroke",
  "stroke-width",
  "stroke-dasharray",
  "vector-effect",
]);

function paths(source: string): readonly VectorPath[] | null {
  if (vectors.has(source)) return vectors.get(source)!;
  const document = new DOMParser().parseFromString(
    `<svg xmlns="http://www.w3.org/2000/svg">${source}</svg>`,
    "image/svg+xml",
  );
  if (
    document.documentElement.localName !== "svg" ||
    document.querySelector("parsererror")
  ) {
    vectors.set(source, null);
    return null;
  }
  const result: VectorPath[] = [];
  for (const element of document.querySelectorAll("*")) {
    if (element === document.documentElement) continue;
    if (
      element.localName === "g" &&
      [...element.attributes].every((a) => a.name === "id")
    )
      continue;
    if (
      element.localName !== "path" ||
      [...element.attributes].some((a) => !attributes.has(a.name)) ||
      [
        element.getAttribute("fill") ?? "black",
        element.getAttribute("stroke") ?? "none",
      ].some(
        (color) =>
          !["none", "black"].includes(color) && !/^#[0-9a-f]{6}$/i.test(color),
      ) ||
      (element.hasAttribute("stroke") &&
        element.getAttribute("stroke") !== "none" &&
        (element.getAttribute("vector-effect") !== "non-scaling-stroke" ||
          !/^[0-9]+(?:\.[0-9]+)?$/.test(
            element.getAttribute("stroke-width") ?? "",
          ))) ||
      (element.hasAttribute("stroke-dasharray") &&
        element.getAttribute("stroke-dasharray") !== "2 1.5") ||
      (element.hasAttribute("fill-rule") &&
        !["evenodd", "nonzero"].includes(element.getAttribute("fill-rule")!))
    ) {
      // Retain the SVG renderer for unsupported future artwork, not an
      // approximation that silently loses transforms, styles or geometry.
      vectors.set(source, null);
      return null;
    }
    const fill = element.getAttribute("fill") ?? "black";
    const stroke = element.getAttribute("stroke") ?? "none";
    let path: Path2D;
    try {
      path = new Path2D(element.getAttribute("d") ?? "");
    } catch {
      vectors.set(source, null);
      return null;
    }
    result.push({
      path,
      fill: MAP_COLORS[fill] ?? fill,
      rule: (element.getAttribute("fill-rule") ?? "nonzero") as CanvasFillRule,
      stroke: MAP_COLORS[stroke] ?? stroke,
      width: Math.max(
        0.8,
        Number(element.getAttribute("stroke-width") ?? 1) * 1.8,
      ),
      dashed: element.hasAttribute("stroke-dasharray"),
    });
  }
  vectors.set(source, result);
  return result;
}

export function rasterizeMapVectors(
  layers: readonly string[],
  viewport: MapViewport,
  pixels: { width: number; height: number },
  strokeScale: number,
  offsets: readonly number[],
): HTMLCanvasElement | undefined {
  if (
    typeof Path2D === "undefined" ||
    typeof Path2D.prototype.addPath !== "function" ||
    typeof DOMMatrix === "undefined" ||
    typeof DOMParser === "undefined"
  )
    return;
  const parsed = layers.filter(Boolean).map(paths);
  if (parsed.some((layer) => layer === null)) return;
  const bitmap = document.createElement("canvas");
  bitmap.width = pixels.width;
  bitmap.height = pixels.height;
  const context = bitmap.getContext("2d");
  if (!context) throw new Error("Map background renderer unavailable.");
  // SVG's default xMidYMid meet, including integer pixel-budget rounding.
  const scale = Math.min(
    pixels.width / viewport.width,
    pixels.height / viewport.height,
  );
  const padX = (pixels.width - viewport.width * scale) / 2;
  const padY = (pixels.height - viewport.height * scale) / 2;
  context.fillStyle = "#091c28";
  context.fillRect(padX, padY, viewport.width * scale, viewport.height * scale);
  context.miterLimit = 4;
  const center = longitudeToX(viewport.centerLongitude);
  for (const offset of offsets) {
    const transform = new DOMMatrix([
      scale * viewport.longitudeScale,
      0,
      0,
      scale,
      padX +
        scale *
          (center * (1 - viewport.longitudeScale) +
            offset * viewport.longitudeScale -
            viewport.x),
      padY - scale * viewport.y,
    ]);
    for (const layer of parsed)
      for (const shape of layer!) {
        const projected = new Path2D();
        projected.addPath(shape.path, transform);
        if (shape.fill !== "none") {
          context.fillStyle = shape.fill;
          context.fill(projected, shape.rule);
        }
        if (shape.stroke !== "none") {
          context.strokeStyle = shape.stroke;
          context.lineWidth = shape.width * strokeScale;
          context.setLineDash(
            shape.dashed ? [4 * strokeScale, 3 * strokeScale] : [],
          );
          context.stroke(projected);
        }
      }
  }
  return bitmap;
}

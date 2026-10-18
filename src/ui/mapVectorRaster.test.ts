// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { rasterizeMapVectors } from "./mapVectorRaster";
import type { MapViewport } from "./positionMapGeometry";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it("reuses parsed geography across zooms with the same projection, colors and non-scaling strokes", () => {
  const parsed: string[] = [],
    matrices: number[][] = [];
  class NativePath {
    constructor(source?: string) {
      if (source) parsed.push(source);
    }
    addPath() {}
  }
  vi.stubGlobal("Path2D", NativePath);
  vi.stubGlobal(
    "DOMMatrix",
    class {
      constructor(values: number[]) {
        matrices.push(values);
      }
    },
  );
  const fills: unknown[] = [],
    strokes: unknown[] = [];
  let dash: number[] = [];
  const context = {
    fillStyle: "",
    strokeStyle: "",
    lineWidth: 0,
    miterLimit: 0,
    fillRect: vi.fn(),
    setLineDash: (values: number[]) => {
      dash = values;
    },
    fill: (_path: unknown, rule: string) => {
      fills.push([context.fillStyle, rule]);
    },
    stroke: () => {
      strokes.push([context.strokeStyle, context.lineWidth, dash]);
    },
  };
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(
    context as unknown as CanvasRenderingContext2D,
  );
  const source =
    '<g id="cache-test"><path d="M350 40L370 60Z" fill="#102c35" fill-rule="evenodd" stroke="#315968" stroke-width="0.7" vector-effect="non-scaling-stroke"/><path d="M355 45L365 55" fill="none" stroke="#355966" stroke-width="0.45" stroke-dasharray="2 1.5" vector-effect="non-scaling-stroke"/></g>';
  const view: MapViewport = {
    x: 340,
    y: 40,
    width: 40,
    height: 40,
    centerLongitude: 0,
    longitudeScale: 0.5,
    local: true,
    zoom: 4,
  };
  const bitmap = rasterizeMapVectors(
    [source],
    view,
    { width: 400, height: 200 },
    2,
    [0],
  );
  expect(bitmap?.width).toBe(400);
  expect(bitmap?.height).toBe(200);
  expect(matrices[0]).toEqual([2.5, 0, 0, 5, -700, -200]);
  expect(fills).toEqual([["#244a58", "evenodd"]]);
  expect(strokes).toEqual([
    ["#83b4c5", 2.52, []],
    ["#8fb0c2", 1.62, [8, 6]],
  ]);
  expect(context.miterLimit).toBe(4);
  rasterizeMapVectors(
    [source],
    { ...view, x: 350, y: 50, width: 20, height: 20 },
    { width: 400, height: 200 },
    2,
    [0],
  );
  expect(parsed).toEqual(["M350 40L370 60Z", "M355 45L365 55"]);
  expect(matrices[1]).toEqual([5, 0, 0, 10, -1600, -500]);
  expect(strokes.slice(2)).toEqual(strokes.slice(0, 2));
  rasterizeMapVectors(
    [source],
    view,
    { width: 400, height: 200 },
    2,
    [-720, 0, 720],
  );
  expect(matrices.slice(2).map((matrix) => matrix[4])).toEqual([
    -2500, -700, 1100,
  ]);
  expect(parsed).toHaveLength(2);
});

it("leaves unsupported artwork to the SVG renderer instead of dropping its transform", () => {
  vi.stubGlobal(
    "Path2D",
    class {
      addPath() {}
    },
  );
  vi.stubGlobal("DOMMatrix", class {});
  const context = vi.spyOn(HTMLCanvasElement.prototype, "getContext");
  const view: MapViewport = {
    x: 0,
    y: 0,
    width: 720,
    height: 360,
    centerLongitude: 0,
    longitudeScale: 1,
    local: false,
    zoom: 0,
  };
  expect(
    rasterizeMapVectors(
      ['<g transform="translate(10 0)"><path d="M0 0L1 1"/></g>'],
      view,
      { width: 400, height: 200 },
      1,
      [0],
    ),
  ).toBeUndefined();
  expect(context).not.toHaveBeenCalled();
});

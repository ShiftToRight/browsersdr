export interface SpectrumSurfaceSettings {
  view: "2d" | "3d";
  seconds: number;
  elevation: number;
  height: number;
  perspective: boolean;
  layout: "combined" | "separate";
}
export const SURFACE_SETTINGS_KEY = "browsersdr.spectrum-surface.v1";
export const SURFACE_MAX_DIMENSION = 4096;
export const SURFACE_TRACE_FRACTION = .30;
export function surfaceSettings(value?: unknown): SpectrumSurfaceSettings {
  const v = value && typeof value === "object" ? value as Partial<SpectrumSurfaceSettings> : {};
  return {
    view: v.view === "3d" ? "3d" : "2d",
    seconds: [4, 8, 10, 16].includes(v.seconds ?? 0) ? v.seconds! : 10,
    elevation: typeof v.elevation === "number" && Number.isFinite(v.elevation) ? Math.max(22, Math.min(60, v.elevation)) : 38,
    height: typeof v.height === "number" && Number.isFinite(v.height) ? Math.max(.5, Math.min(1.6, v.height)) : 1,
    perspective: v.perspective !== false,
    layout: v.layout === "separate" ? "separate" : "combined",
  };
}

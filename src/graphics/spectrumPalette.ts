import type { ThemeId } from "../ui/themes";

type Rgb = readonly [number, number, number];
export interface SpectrumPalette {
  readonly background: Rgb;
  readonly trace: Rgb;
  readonly marker: Rgb;
  readonly waterfall: readonly [Rgb, Rgb, Rgb, Rgb];
  readonly uniforms: readonly number[];
}
function palette(background: Rgb, trace: Rgb, marker: Rgb, waterfall: SpectrumPalette["waterfall"]): SpectrumPalette {
  return { background, trace, marker, waterfall, uniforms: [...waterfall, trace, marker].flatMap((color) => [...color, 1]) };
}
export const SPECTRUM_PALETTES: Record<ThemeId, SpectrumPalette> = {
  classic: palette([.008, .02, .065], [.29, .86, 1], [.34, .86, 1], [[.012, .025, .09], [.18, .08, .58], [.08, .72, .98], [.95, .82, 1]]),
  "field-deck": palette([.07, .07, .075], [1, .78, .54], [1, .42, .16], [[.07, .07, .075], [.32, .08, .025], [.95, .32, .06], [1, .92, .75]]),
  "vice-afterglow": palette([.035, .025, .08], [.32, .95, .97], [1, .35, .67], [[.035, .025, .08], [.20, .045, .48], [.92, .08, .65], [.45, .98, 1]]),
};
export function rgbCss(rgb: Rgb): string {
  return `rgb(${rgb.map((value) => Math.round(value * 255)).join(" ")})`;
}

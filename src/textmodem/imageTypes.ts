import type { DigitalProvenance } from "../digital";
export interface ImageProgress {
  id: number;
  mode: "WEFAX" | "Martin M1" | "Martin M2";
  width: number;
  height: number;
  channels: 1 | 3;
  rows: number;
  complete: boolean;
  reason: string;
  provenance: DigitalProvenance;
}
/** Only one row is sent per event; never an entire raster in a worker snapshot. */
export type ImageScanEvent =
  | { type: "start"; image: ImageProgress }
  | { type: "row"; id: number; row: number; pixels: Uint8Array }
  | { type: "end"; id: number; complete: boolean; reason: string };
/** Main-thread bounded raster, separate from worker DTOs and JSON exports. */
export interface ReceivedImage extends ImageProgress { pixels: Uint8Array; }

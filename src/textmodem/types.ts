import type { DigitalProvenance } from "../digital";
import type { TextMode, TextModemSettings } from "./settings";
import type { ImageProgress } from "./imageTypes";
export interface TextMessage {
  sequence: number;
  text: string;
  integrity: string;
  complete: boolean;
  provenance: DigitalProvenance;
  header?: string;
  address?: string;
  label?: string;
}
export interface TextModemSnapshot {
  mode: TextMode;
  settings: TextModemSettings;
  text: string;
  messages: TextMessage[];
  status: "searching" | "signal" | "decoding";
  signalLevel: number;
  confidence: number;
  frequencyErrorHz: number;
  markHz: number | null;
  spaceHz: number | null;
  image?: ImageProgress;
  decoderStage?: string;
  cwWpm?: number;
  counters: {
    characters: number;
    accepted: number;
    rejected: number;
    framingErrors: number;
    corrected: number;
    discontinuities: number;
  };
}

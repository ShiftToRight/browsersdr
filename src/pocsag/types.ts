import type { DigitalProvenance } from "../digital";
export type PocsagRate = 512 | 1200 | 2400;
export type PocsagEnding =
  | "idle"
  | "next-address"
  | "sync-loss"
  | "source-gap"
  | "queue-overflow"
  | "eof"
  | "reconfigure"
  | "stop"
  | "limit";
export interface PocsagWord {
  received: number;
  corrected: number | null;
  correctionMask: number;
  correctedBits: number;
  payload: boolean;
}
export interface PocsagMessage {
  sequence: number;
  rate: PocsagRate;
  polarity: "normal" | "inverted";
  address: number | null;
  function: number | null;
  interpretation: "numeric" | "alpha" | "raw";
  text: string;
  displayTruncated: boolean;
  payloadBits: string;
  wordEvidence: {
    received: Uint32Array;
    correctionMasks: Uint32Array;
    /** Bit 7: uncorrectable, bits 0–1: correction count, bit 2: treated as payload (assumed for erasure).
     * Corrected words are received XOR correctionMasks; bit 7 has no correction. */
    flags: Uint8Array;
  };
  erasures: number[];
  correctedBits: number;
  /** Known address and ordinary framing end; codeword integrity is separate. */
  complete: boolean;
  ending: PocsagEnding;
  provenance: DigitalProvenance;
}
export interface PocsagCounters {
  complete: number;
  partial: number;
  correctedMessages: number;
  correctedBits: number;
  rejectedWords: number;
  gaps: number;
  evicted: number;
}
export interface PocsagSnapshot {
  configured: boolean;
  state:
    | "searching"
    | "acquiring"
    | "synchronized"
    | "receiving"
    | "degraded"
    | "ended";
  detectedRate: PocsagRate | null;
  polarity: "normal" | "inverted" | null;
  messages: PocsagMessage[];
  inProgress?: PocsagMessage;
  counters: PocsagCounters;
}
export type PocsagEvent = { type: "message"; message: PocsagMessage };
export const POCSAG_MAX_WORDS = 128;
export const POCSAG_MAX_HISTORY = 32;
export const POCSAG_PUBLISHED_MESSAGES = 16;

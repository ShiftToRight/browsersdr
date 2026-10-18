import type { AudioArchive } from "./audioArchive";
import type { SourceSessionMetadata } from "./types";

/** Audio UI registers its optional archive on first use; idle receivers load no retention/export implementation. */
export interface LiveAudioTap {
  /** Borrowed PCM: consume/copy synchronously. No retention on the receiver path. */
  push(owner: object, left: Float32Array, right: Float32Array, rate: number, context: AudioContext): void;
  boundary(owner: object): void;
}
export const audioCaptureTap: { archive?: AudioArchive; live?: LiveAudioTap } = {};

export function audioSourceDescription(session?: SourceSessionMetadata): string {
  return session
    ? `Decoded ${session.source} audio; ${session.mode}; channel ${session.selectedChannelFrequencyHz} Hz; generation ${session.sessionGeneration}. Processed audio, not original I/Q.`
    : "Decoded receiver audio. Processed audio, not original I/Q.";
}

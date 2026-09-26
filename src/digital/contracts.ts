/** Shared, decoder-facing limits. Protocol implementations may choose lower limits. */
export const DIGITAL_MAX_EVENTS_PER_SNAPSHOT = 256;
export const DIGITAL_MAX_SNAPSHOT_BYTES = 256 * 1024;

export interface DigitalDecoderConfiguration {
  /** Acquisition rate actually delivered, not the requested hardware rate. */
  actualInputSampleRateHz: number;
  /** Selected channel minus acquisition center. Positive means above center. */
  selectedChannelOffsetHz: number;
  /** Monotonically changing receiver/session generation. */
  generation: number;
}

export interface DigitalDiscontinuity {
  reason: "source-gap" | "queue-overflow" | "reset" | "reconfigure" | "unknown";
  /** Null means continuity is known to be broken but the size is unknown. */
  missingInputSamples: number | null;
  droppedInputBlocks?: number;
}

export interface DigitalInputBlock {
  I: Float32Array;
  Q: Float32Array;
  generation: number;
  /** Index of I[0]/Q[0] on this generation's acquisition sample clock. */
  firstSampleIndex: number;
  discontinuityBefore?: DigitalDiscontinuity;
}

export interface DigitalProvenance {
  generation: number;
  /** Inclusive acquisition-clock range that contributed to this result. */
  firstInputSampleIndex: number;
  lastInputSampleIndex: number;
  actualInputSampleRateHz: number;
  selectedChannelOffsetHz: number;
}

export interface DigitalPublication<T> {
  sequence: number;
  provenance: DigitalProvenance;
  value: T;
}

/**
 * Synchronous push contract, intentionally close to DigitalSampleReceiver.
 * configure() is atomic: invalid configurations must not disturb the old one.
 */
export interface StreamingDigitalDecoder<TSnapshot, TEvent> {
  configure(configuration: DigitalDecoderConfiguration): void;
  receive(block: DigitalInputBlock): void;
  reset(discontinuity?: DigitalDiscontinuity): void;
  snapshot(): DigitalPublication<TSnapshot>;
  drainEvents(): readonly DigitalPublication<TEvent>[];
  dispose(): void;
}

export function validateDigitalConfiguration(
  configuration: DigitalDecoderConfiguration,
): void {
  if (
    !Number.isFinite(configuration.actualInputSampleRateHz) ||
    configuration.actualInputSampleRateHz <= 0
  )
    throw new Error(
      "Digital decoder input sample rate must be positive and finite.",
    );
  if (!Number.isFinite(configuration.selectedChannelOffsetHz))
    throw new Error("Digital decoder channel offset must be finite.");
  if (
    Math.abs(configuration.selectedChannelOffsetHz) >=
    configuration.actualInputSampleRateHz / 2
  )
    throw new Error(
      "Digital decoder channel offset must be inside the input Nyquist range.",
    );
  if (
    !Number.isSafeInteger(configuration.generation) ||
    configuration.generation < 0
  )
    throw new Error(
      "Digital decoder generation must be a non-negative safe integer.",
    );
}

export function validateDigitalInputBlock(block: DigitalInputBlock): void {
  if (block.I.length !== block.Q.length)
    throw new Error("Digital decoder input must have equal I/Q lengths.");
  if (block.I.length === 0)
    throw new Error("Digital decoder input blocks must not be empty.");
  if (!Number.isSafeInteger(block.generation) || block.generation < 0)
    throw new Error("Digital decoder input generation is invalid.");
  if (
    !Number.isSafeInteger(block.firstSampleIndex) ||
    block.firstSampleIndex < 0
  )
    throw new Error("Digital decoder input sample index is invalid.");
}

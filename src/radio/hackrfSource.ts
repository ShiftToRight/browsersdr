import type { IngressTimings } from "./ingressTimings";
import { signedByteToFloat } from "./iqRecording";
import type { SampleReceiver } from "@jtarrio/signals/radio/sample_receiver.js";
import type { SampleBlock } from "@jtarrio/signals/radio/sample_block.js";
import type { HackrfConfiguredSession } from "./hackrfProtocol";
import { HACKRF_MAX_COMPLEX_SAMPLES, type NativeIqBlock } from "./hackrfTransport";

/** A synchronous push adapter for the installed Signals SampleReceiver API.
 * The transport owns reads; using SignalSource.readSamples as a second pump would
 * add a queue. The native recorder copies first; Signals buffers are reused after
 * receiveSamples returns. No async consumer may retain these views. */
export class HackrfSampleAdapter {
  private readonly I = new Float32Array(HACKRF_MAX_COMPLEX_SAMPLES);
  private readonly Q = new Float32Array(HACKRF_MAX_COMPLEX_SAMPLES);
  private session?: HackrfConfiguredSession;
  constructor(private readonly receiver: SampleReceiver & { receiveCi8?(bytes: Uint8Array, frequency: number): boolean }, private readonly capture?: (block: NativeIqBlock) => void, private readonly timings?: IngressTimings) {}

  readonly ready = (session: HackrfConfiguredSession): void => {
    this.session = structuredClone(session);
    this.receiver.setSampleRate(session.details.nativeSampleRateHz);
  };
  reset(): void { this.session = undefined; }
  readonly receive = (block: NativeIqBlock): void => {
    const session = this.session;
    if (!session || block.generation !== session.generation) return;
    if (block.encoding !== "ci8" || block.sampleOrder !== "interleaved-iq" || block.bytesPerComplexSample !== 2
      || !Number.isInteger(block.complexSampleCount) || block.complexSampleCount < 1 || block.complexSampleCount > HACKRF_MAX_COMPLEX_SAMPLES
      || block.bytes.byteLength !== block.complexSampleCount * 2 || block.nativeSampleRateHz !== session.details.nativeSampleRateHz) throw new Error("Invalid HackRF native I/Q block.");
    if (block.discontinuityBefore) throw new Error("HackRF discontinuity requires a fresh configured receiver generation.");
    const captureStart = performance.now();
    const captured: unknown = this.capture?.(block);
    this.timings?.record("Native capture", performance.now() - captureStart);
    if (captured && typeof (captured as PromiseLike<unknown>).then === "function") {
      void Promise.resolve(captured).catch(() => undefined);
      throw new Error("HackRF native capture must copy synchronously.");
    }
    if (this.receiver.receiveCi8?.(block.bytes, session.hardwareCenterFrequencyHz)) return;
    const conversionStart = performance.now();
    for (let index = 0; index < block.complexSampleCount; index++) {
      const i = block.bytes[index * 2]!; const q = block.bytes[index * 2 + 1]!;
      this.I[index] = signedByteToFloat(i);
      this.Q[index] = signedByteToFloat(q);
    }
    this.timings?.record("Main-thread normalization", performance.now() - conversionStart);
    const samples: SampleBlock = { I: this.I.subarray(0, block.complexSampleCount), Q: this.Q.subarray(0, block.complexSampleCount), frequency: session.hardwareCenterFrequencyHz };
    // Step 04 supplies the existing raw-analysis-before-mutating-audio fan-out.
    const delivered: unknown = this.receiver.receiveSamples(samples);
    if (delivered && typeof (delivered as PromiseLike<unknown>).then === "function") {
      void Promise.resolve(delivered).catch(() => undefined);
      throw new Error("HackRF Signals receiver must consume synchronously.");
    }
  };
}

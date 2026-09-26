import type { SampleBlock } from "@jtarrio/signals/radio/sample_block.js";
import type { SampleReceiver } from "@jtarrio/signals/radio/sample_receiver.js";
import { BLADERF_MAX_COMPLEX_SAMPLES, type BladeRfSessionDetails } from "./bladerfProtocol";
import type { BladeRfConfiguredSession, BladeRfNativeBlock } from "./bladerfTransport";
import { decodeSc16Q11Into } from "./sc16Samples";

/** Converts native little-endian SC16 Q11 into the shared planar float path. */
export class BladeRfSampleAdapter {
  private readonly I = new Float32Array(BLADERF_MAX_COMPLEX_SAMPLES);
  private readonly Q = new Float32Array(BLADERF_MAX_COMPLEX_SAMPLES);
  private session?: BladeRfConfiguredSession;
  constructor(private readonly receiver: SampleReceiver & { receiveSc16?(bytes: Uint8Array, frequency: number): boolean }) {}

  ready(session: BladeRfConfiguredSession): void {
    this.session = structuredClone(session);
    this.receiver.setSampleRate(session.details.nativeSampleRateHz);
  }
  reset(): void { this.session = undefined; }
  receive(block: BladeRfNativeBlock): void {
    const session = this.session;
    if (!session || block.generation !== session.generation) return;
    validateBladeRfBlock(block, session.details);
    if (this.receiver.receiveSc16?.(block.bytes, session.hardwareCenterFrequencyHz)) return;
    decodeSc16Q11Into(block.bytes, this.I, this.Q);
    const samples: SampleBlock = { I: this.I.subarray(0, block.complexSampleCount), Q: this.Q.subarray(0, block.complexSampleCount), frequency: session.hardwareCenterFrequencyHz };
    const delivered: unknown = this.receiver.receiveSamples(samples);
    if (delivered && typeof (delivered as PromiseLike<unknown>).then === "function") throw new Error("bladeRF sample consumers must be synchronous.");
  }
}

export function validateBladeRfBlock(block: BladeRfNativeBlock, details: BladeRfSessionDetails): void {
  if (block.encoding !== "ci16_le_sc11" || block.sampleOrder !== "interleaved-iq" || block.bytesPerComplexSample !== 4
    || !Number.isInteger(block.complexSampleCount) || block.complexSampleCount < 1 || block.complexSampleCount > BLADERF_MAX_COMPLEX_SAMPLES
    || block.bytes.byteLength !== block.complexSampleCount * 4 || block.nativeSampleRateHz !== details.nativeSampleRateHz) throw new Error("Invalid bladeRF SC16 Q11 sample block.");
}

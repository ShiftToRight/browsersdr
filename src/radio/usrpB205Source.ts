import type { SampleBlock } from "@jtarrio/signals/radio/sample_block.js";
import type { SampleReceiver } from "@jtarrio/signals/radio/sample_receiver.js";
import type { UsrpB205SessionDetails } from "./usrpB205Capabilities";
import {
  USRP_B205_RX_MAX_COMPLEX_SAMPLES,
  decodeUsrpB205Sc16Into,
} from "./usrpB205RxVrt";
import type { UsrpB205Discontinuity, UsrpB205NativeBlock } from "./usrpB205RxTransport";
import type { IngressTimings } from "./ingressTimings";
import { CHANNEL_MAX_SAMPLES } from "./widebandChannel";

export interface UsrpB205AdapterSession {
  readonly generation: number;
  readonly details: UsrpB205SessionDetails;
}

/** Synchronous SC16-to-planar adapter. Native observers must copy before return. */
export class UsrpB205SampleAdapter {
  private readonly packetI = new Float32Array(USRP_B205_RX_MAX_COMPLEX_SAMPLES);
  private readonly packetQ = new Float32Array(USRP_B205_RX_MAX_COMPLEX_SAMPLES);
  private readonly deliveryI = new Float32Array(CHANNEL_MAX_SAMPLES);
  private readonly deliveryQ = new Float32Array(CHANNEL_MAX_SAMPLES);
  private deliveryCount = 0;
  private session?: UsrpB205AdapterSession;

  constructor(
    private readonly receiver: SampleReceiver,
    private readonly observeNative?: (block: UsrpB205NativeBlock) => void,
    private readonly onDiscontinuity?: (value: UsrpB205Discontinuity) => void,
    private readonly timings?: IngressTimings,
    private readonly now: () => number = () => performance.now(),
  ) {}

  ready(session: UsrpB205AdapterSession): void {
    this.deliveryCount = 0;
    this.session = structuredClone(session);
    this.receiver.setSampleRate(session.details.nativeSampleRateHz);
  }

  reset(): void {
    this.deliveryCount = 0;
    this.session = undefined;
  }

  receive = (block: UsrpB205NativeBlock): void => {
    const session = this.session;
    if (!session || block.generation !== session.generation) return;
    this.validate(block, session.details);
    const captureStarted = this.now();
    this.callSync(this.observeNative, block, "native packet observer");
    this.timings?.record("Native capture", this.now() - captureStarted);
    if (block.discontinuityBefore) {
      this.deliver(session.details.configuration.acceptedCenterFrequencyHz);
      this.callSync(this.onDiscontinuity, block.discontinuityBefore, "discontinuity observer");
    }
    const conversionStarted = this.now();
    const count = decodeUsrpB205Sc16Into(block.bytes, this.packetI, this.packetQ);
    this.timings?.record("Main-thread normalization", this.now() - conversionStarted);
    if (count === 0) return;
    if (this.deliveryCount + count > CHANNEL_MAX_SAMPLES)
      this.deliver(session.details.configuration.acceptedCenterFrequencyHz);
    this.deliveryI.set(this.packetI.subarray(0, count), this.deliveryCount);
    this.deliveryQ.set(this.packetQ.subarray(0, count), this.deliveryCount);
    this.deliveryCount += count;
    if (this.deliveryCount === CHANNEL_MAX_SAMPLES || block.endOfBurst)
      this.deliver(session.details.configuration.acceptedCenterFrequencyHz);
  };

  /** Coalesce small VRT payloads into worker-sized blocks. This preserves the
   * fixed worker memory budget as a time budget instead of consuming one
   * 32,768-sample slot for each 4,086-sample USB packet. */
  private deliver(frequency: number): void {
    if (this.deliveryCount === 0) return;
    const samples: SampleBlock = {
      I: this.deliveryI.subarray(0, this.deliveryCount),
      Q: this.deliveryQ.subarray(0, this.deliveryCount),
      frequency,
    };
    const delivered: unknown = this.receiver.receiveSamples(samples);
    if (delivered && typeof (delivered as PromiseLike<unknown>).then === "function") {
      void Promise.resolve(delivered).catch(() => undefined);
      throw new Error("USRP B205-mini Signals receiver must consume synchronously.");
    }
    this.deliveryCount = 0;
  }

  private validate(block: UsrpB205NativeBlock, details: UsrpB205SessionDetails): void {
    if (block.encoding !== "chdr-vrt-sc16-le" || block.sampleWordOrder !== "i16-msw-q16-lsw"
      || block.bytesPerComplexSample !== 4 || block.nativeSampleRateHz !== details.nativeSampleRateHz
      || !Number.isInteger(block.complexSampleCount) || block.complexSampleCount < 0
      || block.complexSampleCount > USRP_B205_RX_MAX_COMPLEX_SAMPLES
      || block.bytes.byteLength !== block.complexSampleCount * 4
      || block.nativePacketBytes.byteLength !== block.bytes.byteLength + 16
      || block.bytes.buffer !== block.nativePacketBytes.buffer) {
      throw new Error("Invalid USRP B205-mini native SC16 block.");
    }
  }

  private callSync<T>(callback: ((value: T) => void) | undefined, value: T, name: string): void {
    const returned: unknown = callback?.(value);
    if (returned && typeof (returned as PromiseLike<unknown>).then === "function") {
      void Promise.resolve(returned).catch(() => undefined);
      throw new Error(`USRP B205-mini ${name} must consume synchronously.`);
    }
  }
}

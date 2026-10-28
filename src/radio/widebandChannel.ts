import {
  WasmHalfBandStage as HalfBandStage,
  CHANNEL_MAX_SAMPLES,
} from "./wasmHalfBand";
import { isAirspyRate } from "./airspySettings";
export {
  WasmHalfBandStage as HalfBandStage,
  CHANNEL_MAX_SAMPLES,
} from "./wasmHalfBand";
import type { IngressTimings } from "./ingressTimings";
import { defaultDiagnosticRecorder } from "../diagnostics/diagnosticRecorder";
import type { SampleBlock } from "@jtarrio/signals/radio/sample_block.js";

export const WIDEBAND_RATE = 4_800_000;
export const CHANNEL_RATE = 2_400_000;
export const CHANNEL_FIR_TAPS = 95;
/** About 437 ms of fixed channel-worker headroom at every native rate. This is
 * large enough for observed browser scheduling/tiering spikes while remaining
 * strictly bounded; average compute must still stay below sample time. */
export const CHANNEL_WORKER_SLOTS = 64;
/** A 64 KiB bladeRF SC16 transfer contains half as many complex samples as a
 * 64 KiB HackRF CI8 transfer. Keep this explicit so block-count pools preserve
 * the same amount of sample time for both native encodings. */
export const CHANNEL_SC16_MAX_SAMPLES = 16_384;
export const CHANNEL_USRP_SC16_MAX_SAMPLES = 65_536;

/** Cascaded 19.2 → 9.6 → 4.8 → 2.4 MS/s path, entering at the native rate.
 * The 15/31-tap early stages protect the final ±1 MHz passband from aliases;
 * the final 95-tap stage retains the original v1 response. */
export class WidebandChannelFilter {
  private readonly first: HalfBandStage;
  private readonly second?: HalfBandStage | WidebandChannelFilter;
  constructor(offsetHz = 0, rate = WIDEBAND_RATE) {
    if (rate !== WIDEBAND_RATE && rate !== 9_600_000 && rate !== 19_200_000)
      throw new Error("Unsupported wideband channel rate.");
    this.first = new HalfBandStage(
      offsetHz,
      rate,
      rate === WIDEBAND_RATE ? CHANNEL_FIR_TAPS : rate === 9_600_000 ? 31 : 15,
    );
    if (rate === 19_200_000)
      this.second = new WidebandChannelFilter(0, 9_600_000);
    if (rate === 9_600_000)
      this.second = new HalfBandStage(0, WIDEBAND_RATE, CHANNEL_FIR_TAPS);
  }
  reset(offsetHz: number): void {
    this.first.reset(offsetHz);
    this.second?.reset(0);
  }
  process(I: Float32Array, Q: Float32Array): number {
    const count = this.first.process(I, Q);
    return this.second
      ? this.second.process(I.subarray(0, count), Q.subarray(0, count))
      : count;
  }
}
export interface Ci8ChannelBlock {
  type: "ci8";
  generation: number;
  bytes: Uint8Array<ArrayBuffer>;
  inputCount: number;
  I: Float32Array<ArrayBuffer>;
  Q: Float32Array<ArrayBuffer>;
  frequency: number;
  sentAtMs?: number;
}
export interface Sc16ChannelBlock {
  type: "sc16";
  generation: number;
  bytes: Uint8Array<ArrayBuffer>;
  inputCount: number;
  I: Float32Array<ArrayBuffer>;
  Q: Float32Array<ArrayBuffer>;
  frequency: number;
  sentAtMs?: number;
}
export interface UsrpSc16ChannelBlock extends Omit<Sc16ChannelBlock, "type"> {
  type: "usrp-sc16";
}
export type NativeChannelEncoding = false | "ci8" | "sc16" | "usrp-sc16";
export type ChannelWorkerInput =
  | Ci8ChannelBlock
  | Sc16ChannelBlock
  | UsrpSc16ChannelBlock
  | {
      type: "configure";
      generation: number;
      offsetHz: number;
      sampleRateHz?: number;
      native?: NativeChannelEncoding;
    }
  | {
      type: "samples";
      generation: number;
      I: Float32Array<ArrayBuffer>;
      Q: Float32Array<ArrayBuffer>;
      frequency: number;
      sentAtMs?: number;
    };
export type ChannelWorkerOutput =
  | ((Ci8ChannelBlock | Sc16ChannelBlock | UsrpSc16ChannelBlock) & {
      count: number;
      processingMs?: number;
    })
  | { type: "ready"; generation: number }
  | {
      type: "samples";
      generation: number;
      I: Float32Array<ArrayBuffer>;
      Q: Float32Array<ArrayBuffer>;
      count: number;
      frequency: number;
      processingMs?: number;
      sentAtMs?: number;
    }
  | { type: "error"; message: string };
export type ChannelWorkerPort = Pick<
  Worker,
  "postMessage" | "terminate" | "onmessage" | "onerror"
>;

export interface ChannelDiagnostics {
  queuedBlocks: number;
  capacityBlocks: number;
  peakQueuedBlocks: number;
  recentBlocks: number;
  computeAverageMs: number;
  computeMaximumMs: number;
  deliveryAverageMs: number;
  turnaroundMaximumMs: number;
  computeBudgetPercent: number;
}

/** One fixed transfer pool shared across generations. Stale replies return their
 * buffers but never reach DSP. Saturation fails explicitly rather than dropping
 * mandatory audio/decoder input or growing an unbounded queue. */
export class WidebandChannelWorker {
  // Last 256 current-generation replies, fixed storage and no per-block objects.
  private readonly timings = new Float64Array(256 * 4);
  private timingIndex = 0;
  private timingCount = 0;
  private peakQueuedBlocks = 0;
  private sampleRateHz = WIDEBAND_RATE;
  get diagnostics(): ChannelDiagnostics {
    let compute = 0,
      delivery = 0,
      maximum = 0,
      turnaround = 0,
      inputMs = 0;
    for (let n = 0; n < this.timingCount; n++) {
      const p = n * 4;
      compute += this.timings[p]!;
      maximum = Math.max(maximum, this.timings[p]!);
      delivery += this.timings[p + 1]!;
      turnaround = Math.max(turnaround, this.timings[p + 2]!);
      inputMs += this.timings[p + 3]!;
    }
    return {
      queuedBlocks: this.closed
        ? 0
        : this.allocatedSlots -
          (this.native ? this.nativePool.length : this.pool.length),
      capacityBlocks: this.allocatedSlots,
      peakQueuedBlocks: this.peakQueuedBlocks,
      recentBlocks: this.timingCount,
      computeAverageMs: compute / (this.timingCount || 1),
      computeMaximumMs: maximum,
      deliveryAverageMs: delivery / (this.timingCount || 1),
      turnaroundMaximumMs: turnaround,
      computeBudgetPercent: inputMs ? (compute / inputMs) * 100 : 0,
    };
  }
  private lastWorkerMs: number | undefined;
  private lastDeliveryMs = 0;
  private lastReplyAt = performance.now();
  private readonly worker: ChannelWorkerPort;
  private readonly pool: (readonly [ArrayBuffer, ArrayBuffer])[] = [];
  private readonly nativePool: {
    bytes: ArrayBuffer;
    I: ArrayBuffer;
    Q: ArrayBuffer;
  }[] = [];
  private native: NativeChannelEncoding = false;
  private allocatedSlots = 0;
  private generation = 0;
  private closed = false;
  private started = false;
  private resolveReady!: () => void;
  private rejectReady!: (error: Error) => void;
  private readonly ready: Promise<void>;
  private readonly timer: ReturnType<typeof setTimeout>;
  constructor(
    private readonly deliver: (block: SampleBlock) => void,
    private readonly error: (error: Error) => void,
    factory = (): ChannelWorkerPort =>
      new Worker(new URL("../workers/channel.worker.ts", import.meta.url), {
        type: "module",
      }),
    private readonly ingressTimings?: IngressTimings,
  ) {
    this.ready = new Promise<void>((resolve, reject) => {
      this.resolveReady = resolve;
      this.rejectReady = reject;
    });
    void this.ready.catch(() => undefined);
    this.worker = factory();
    this.timer = setTimeout(
      () => this.fail(new Error("Wideband channel worker startup timed out.")),
      2_000,
    );
    this.worker.onerror = () =>
      this.fail(new Error("Wideband channel worker failed."));
    this.worker.onmessage = (event: MessageEvent<ChannelWorkerOutput>) => {
      if (this.closed) return;
      const message = event.data;
      if (message.type === "error") {
        this.fail(new Error(message.message));
        return;
      }
      if (message.type === "ready") {
        clearTimeout(this.timer);
        this.resolveReady();
        return;
      }
      this.lastWorkerMs = message.processingMs;
      const deliveryStart = performance.now();
      try {
        if (
          message.generation === this.generation &&
          this.started &&
          message.count > 0
        ) {
          this.deliver({
            I: message.I.subarray(0, message.count),
            Q: message.Q.subarray(0, message.count),
            frequency: message.frequency,
          });
        }
      } catch (error) {
        this.fail(error instanceof Error ? error : new Error(String(error)));
      } finally {
        this.lastReplyAt = performance.now();
        this.lastDeliveryMs = this.lastReplyAt - deliveryStart;
        if (
          message.generation === this.generation &&
          this.started &&
          message.processingMs !== undefined
        ) {
          const p = this.timingIndex * 4;
          this.timings[p] = message.processingMs;
          this.timings[p + 1] = this.lastDeliveryMs;
          this.timings[p + 2] =
            message.sentAtMs === undefined
              ? 0
              : this.lastReplyAt - message.sentAtMs;
          this.timings[p + 3] =
            ((message.type === "samples"
              ? message.I.length
              : message.inputCount) /
              this.sampleRateHz) *
            1000;
          this.timingIndex = (this.timingIndex + 1) % 256;
          this.timingCount = Math.min(256, this.timingCount + 1);
        }
        if (!this.closed) {
          if (message.type !== "samples")
            this.nativePool.push({
              bytes: message.bytes.buffer,
              I: message.I.buffer,
              Q: message.Q.buffer,
            });
          else this.pool.push([message.I.buffer, message.Q.buffer]);
        }
      }
    };
  }
  configure(
    generation: number,
    offsetHz: number,
    sampleRateHz = WIDEBAND_RATE,
    native: NativeChannelEncoding = false,
  ): Promise<void> {
    if (this.closed) throw new Error("Wideband channel worker is closed.");
    // Preserve ~437 ms of native input for every rate and encoding. bladeRF
    // SC16 transfers contain 16,384 samples while CI8/float blocks contain up
    // to 32,768, so SC16 needs twice as many fixed slots. Never grow on pressure.
    const maxInputSamples =
      native === "usrp-sc16"
        ? CHANNEL_USRP_SC16_MAX_SAMPLES
        : native === "sc16"
          ? CHANNEL_SC16_MAX_SAMPLES
          : isAirspyRate(sampleRateHz) ? 16_384 : CHANNEL_MAX_SAMPLES;
    const slots =
      (((CHANNEL_WORKER_SLOTS * sampleRateHz) / WIDEBAND_RATE) *
        CHANNEL_MAX_SAMPLES) /
      maxInputSamples;
    if (
      this.allocatedSlots &&
      (this.native !== native || (native && this.sampleRateHz !== sampleRateHz))
    )
      throw new Error(
        "Recreate channel worker before changing its pool format/rate.",
      );
    this.native = native;
    while (this.allocatedSlots < slots) {
      if (native) {
        const outputBytes =
          Math.ceil((maxInputSamples * CHANNEL_RATE) / sampleRateHz) * 4;
        this.nativePool.push({
          bytes: new ArrayBuffer(maxInputSamples * (native === "ci8" ? 2 : 4)),
          I: new ArrayBuffer(outputBytes),
          Q: new ArrayBuffer(outputBytes),
        });
      } else
        this.pool.push([
          new ArrayBuffer(CHANNEL_MAX_SAMPLES * 4),
          new ArrayBuffer(CHANNEL_MAX_SAMPLES * 4),
        ]);
      this.allocatedSlots++;
    }
    if (this.generation !== generation) {
      this.timingIndex = 0;
      this.timingCount = 0;
      this.peakQueuedBlocks = 0;
    }
    this.sampleRateHz = sampleRateHz;
    this.generation = generation;
    this.started = true;
    this.worker.postMessage({
      type: "configure",
      generation,
      offsetHz,
      sampleRateHz,
      native,
    } satisfies ChannelWorkerInput);
    return this.ready;
  }
  receive(block: SampleBlock, selectedFrequency: number): void {
    if (this.closed || !this.started) return;
    if (
      block.I.length !== block.Q.length ||
      block.I.length > CHANNEL_MAX_SAMPLES
    )
      throw new Error("Wideband input exceeds its fixed block budget.");
    const pair = this.pool.pop();
    if (!pair) throw this.queueExhausted();
    this.peakQueuedBlocks = Math.max(
      this.peakQueuedBlocks,
      this.allocatedSlots -
        (this.native ? this.nativePool.length : this.pool.length),
    );
    const I = new Float32Array(pair[0], 0, block.I.length),
      Q = new Float32Array(pair[1], 0, block.Q.length);
    I.set(block.I);
    Q.set(block.Q);
    this.worker.postMessage(
      {
        type: "samples",
        generation: this.generation,
        I,
        Q,
        frequency: selectedFrequency,
        sentAtMs: performance.now(),
      } satisfies ChannelWorkerInput,
      [pair[0], pair[1]],
    );
  }
  receiveCi8(bytes: Uint8Array, selectedFrequency: number): void {
    this.receiveNative("ci8", bytes, selectedFrequency);
  }
  receiveSc16(bytes: Uint8Array, selectedFrequency: number): void {
    this.receiveNative("sc16", bytes, selectedFrequency);
  }
  receiveUsrpSc16(bytes: Uint8Array, selectedFrequency: number): void {
    this.receiveNative("usrp-sc16", bytes, selectedFrequency);
  }
  private receiveNative(
    encoding: Exclude<NativeChannelEncoding, false>,
    bytes: Uint8Array,
    selectedFrequency: number,
  ): void {
    if (this.closed || !this.started) return;
    const inputCount = bytes.byteLength / (encoding === "ci8" ? 2 : 4);
    const maximum =
      encoding === "usrp-sc16"
        ? CHANNEL_USRP_SC16_MAX_SAMPLES
        : encoding === "sc16"
          ? CHANNEL_SC16_MAX_SAMPLES
          : CHANNEL_MAX_SAMPLES;
    if (
      this.native !== encoding ||
      !Number.isInteger(inputCount) ||
      inputCount < 1 ||
      inputCount > maximum
    )
      throw new Error("Invalid native channel block.");
    const slot = this.nativePool.pop();
    if (!slot) throw this.queueExhausted();
    this.peakQueuedBlocks = Math.max(
      this.peakQueuedBlocks,
      this.allocatedSlots - this.nativePool.length,
    );
    const copyStart = performance.now();
    const input = new Uint8Array(slot.bytes, 0, bytes.byteLength);
    input.set(bytes);
    this.ingressTimings?.record("Channel copy", performance.now() - copyStart);
    const dispatchStart = performance.now();
    this.worker.postMessage(
      {
        type: encoding,
        generation: this.generation,
        bytes: input,
        inputCount,
        I: new Float32Array(slot.I),
        Q: new Float32Array(slot.Q),
        frequency: selectedFrequency,
        sentAtMs: performance.now(),
      } satisfies ChannelWorkerInput,
      [slot.bytes, slot.I, slot.Q],
    );
    this.ingressTimings?.record(
      "Channel dispatch",
      performance.now() - dispatchStart,
    );
  }
  private queueExhausted(): Error {
    const stats = this.diagnostics;
    const fallback =
      this.sampleRateHz === 19_200_000
        ? "9.6"
        : this.sampleRateHz === 9_600_000
          ? "4.8 or 2.4"
          : "2.4";
    return new Error(
      `Wideband channel processing cannot sustain ${this.sampleRateHz / 1_000_000} MS/s; bounded queue exhausted and continuity is unknown. Last worker block ${this.lastWorkerMs?.toFixed(2) ?? "unavailable"} ms, last delivery ${this.lastDeliveryMs.toFixed(2)} ms, time since reply ${(performance.now() - this.lastReplyAt).toFixed(2)} ms. Recent ${stats.recentBlocks} blocks: compute ${stats.computeAverageMs.toFixed(2)} ms average / ${stats.computeMaximumMs.toFixed(2)} ms maximum (${stats.computeBudgetPercent.toFixed(1)}% of sample time), delivery ${stats.deliveryAverageMs.toFixed(2)} ms average, round trip ${stats.turnaroundMaximumMs.toFixed(2)} ms maximum. Select ${fallback} MS/s on this host.`,
    );
  }
  reset(): void {
    this.started = false;
  }
  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.started = false;
    clearTimeout(this.timer);
    this.rejectReady(new Error("Wideband channel worker closed."));
    this.worker.terminate();
    this.pool.length = 0;
    this.nativePool.length = 0;
  }
  private fail(error: Error): void {
    if (!this.closed) {
      defaultDiagnosticRecorder.record({
        area: "channel",
        code: "CHANNEL_WORKER_FAILURE",
        severity: "error",
        operation: "worker",
        error,
        autoSubmitEligible: true,
        context: { sampleRateHz: this.sampleRateHz },
      });
      this.close();
      this.error(error);
    }
  }
}

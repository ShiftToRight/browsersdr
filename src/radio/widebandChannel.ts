import type { SampleBlock } from "@jtarrio/signals/radio/sample_block.js";

export const WIDEBAND_RATE = 4_800_000;
export const CHANNEL_RATE = 2_400_000;
export const CHANNEL_FIR_TAPS = 95;
export const CHANNEL_MAX_SAMPLES = 32_768;
export const CHANNEL_WORKER_SLOTS = 8;

/** Symmetric Blackman half-band stage. Only retained output phases are evaluated.
 * Fixed storage, no per-sample allocation. State/oscillator reset at each generation/gap.
 * The original 95-tap stage at 4.8 MS/s preserves ±1 MHz, rejecting from ±1.4 MHz;
 * its 1.0–1.2 MHz output edge is a guard band. Delay is (tapCount - 1) / 2 input samples. */
class HalfBandStage {
  private readonly taps: Float64Array;
  private readonly historyI: Float64Array;
  private readonly historyQ: Float64Array;
  private cursor = 0;
  private parity = 0;
  private oscillatorI = 1;
  private oscillatorQ = 0;
  private rotationI = 1;
  private rotationQ = 0;
  private count = 0;
  private mixing = false;
  constructor(offsetHz: number, private readonly rate: number, private readonly tapCount: number) {
    this.taps = new Float64Array(tapCount);
    this.historyI = new Float64Array(tapCount * 2); this.historyQ = new Float64Array(tapCount * 2);
    const middle = (this.tapCount - 1) / 2;
    const cutoff = 0.25;
    let sum = 0;
    for (let n = 0; n < this.tapCount; n++) {
      const x = n - middle;
      const sinc = x === 0 ? 2 * cutoff : x % 2 === 0 ? 0 : Math.sin(2 * Math.PI * cutoff * x) / (Math.PI * x);
      const window = 0.42 - 0.5 * Math.cos(2 * Math.PI * n / (this.tapCount - 1)) + 0.08 * Math.cos(4 * Math.PI * n / (this.tapCount - 1));
      this.taps[n] = sinc * window; sum += this.taps[n]!;
    }
    for (let n = 0; n < this.tapCount; n++) this.taps[n] = this.taps[n]! / sum;
    this.reset(offsetHz);
  }
  reset(offsetHz: number): void {
    if (!Number.isFinite(offsetHz) || Math.abs(offsetHz) >= this.rate / 2) throw new Error("Invalid wideband channel offset.");
    this.historyI.fill(0); this.historyQ.fill(0); this.cursor = 0; this.parity = 0; this.count = 0;
    this.oscillatorI = 1; this.oscillatorQ = 0;
    this.mixing = offsetHz !== 0;
    this.rotationI = Math.cos(-2 * Math.PI * offsetHz / this.rate);
    this.rotationQ = Math.sin(-2 * Math.PI * offsetHz / this.rate);
  }
  /** In-place result occupies the first returned-count elements of I and Q. */
  process(I: Float32Array, Q: Float32Array): number {
    if (I.length !== Q.length || I.length > CHANNEL_MAX_SAMPLES) throw new Error("Invalid wideband channel block size.");
    let out = 0;
    for (let n = 0; n < I.length; n++) {
      let i = I[n]!, q = Q[n]!;
      if (this.mixing) {
        i = I[n]! * this.oscillatorI - Q[n]! * this.oscillatorQ;
        q = I[n]! * this.oscillatorQ + Q[n]! * this.oscillatorI;
        const nextI = this.oscillatorI * this.rotationI - this.oscillatorQ * this.rotationQ;
        this.oscillatorQ = this.oscillatorI * this.rotationQ + this.oscillatorQ * this.rotationI; this.oscillatorI = nextI;
        if (++this.count === 4096) {
          const norm = Math.hypot(this.oscillatorI, this.oscillatorQ);
          this.oscillatorI /= norm; this.oscillatorQ /= norm; this.count = 0;
        }
      }
      const index = this.cursor;
      this.historyI[index] = this.historyI[index + this.tapCount] = i;
      this.historyQ[index] = this.historyQ[index + this.tapCount] = q;
      this.cursor = index + 1 === this.tapCount ? 0 : index + 1;
      this.parity ^= 1;
      if (this.parity !== 0) continue;
      let sumI = 0, sumQ = 0;
      // Symmetric half-band FIR: skip zero taps, pair symmetric coefficients.
      // Contiguous mirrored history avoids modulo arithmetic inside the FIR.
      const start = this.cursor;
      const middle = (this.tapCount - 1) / 2;
      for (let t = 0; t < middle; t += 2) {
        sumI += this.taps[t]! * (this.historyI[start + t]! + this.historyI[start + this.tapCount - 1 - t]!);
        sumQ += this.taps[t]! * (this.historyQ[start + t]! + this.historyQ[start + this.tapCount - 1 - t]!);
      }
      I[out] = sumI + this.taps[middle]! * this.historyI[start + middle]!;
      Q[out] = sumQ + this.taps[middle]! * this.historyQ[start + middle]!;
      out++;
    }
    return out;
  }
}
/** Cascaded 9.6 → 4.8 → 2.4 MS/s path; the second stage is the original v1 filter.
 * Stage one only needs to protect the final ±1 MHz passband from ±3.8 MHz aliases. */
export class WidebandChannelFilter {
  private readonly first: HalfBandStage;
  private readonly second?: HalfBandStage;
  constructor(offsetHz = 0, rate = WIDEBAND_RATE) {
    if (rate !== WIDEBAND_RATE && rate !== 9_600_000) throw new Error("Unsupported wideband channel rate.");
    this.first = new HalfBandStage(offsetHz, rate, rate === WIDEBAND_RATE ? CHANNEL_FIR_TAPS : 31);
    if (rate === 9_600_000) this.second = new HalfBandStage(0, WIDEBAND_RATE, CHANNEL_FIR_TAPS);
  }
  reset(offsetHz: number): void { this.first.reset(offsetHz); this.second?.reset(0); }
  process(I: Float32Array, Q: Float32Array): number {
    const count = this.first.process(I, Q);
    return this.second ? this.second.process(I.subarray(0, count), Q.subarray(0, count)) : count;
  }
}
export type ChannelWorkerInput = { type: "configure"; generation: number; offsetHz: number; sampleRateHz?: number }
  | { type: "samples"; generation: number; I: Float32Array<ArrayBuffer>; Q: Float32Array<ArrayBuffer>; frequency: number };
export type ChannelWorkerOutput = { type: "ready"; generation: number }
  | { type: "samples"; generation: number; I: Float32Array<ArrayBuffer>; Q: Float32Array<ArrayBuffer>; count: number; frequency: number }
  | { type: "error"; message: string };
export type ChannelWorkerPort = Pick<Worker, "postMessage" | "terminate" | "onmessage" | "onerror">;

/** One fixed transfer pool shared across generations. Stale replies return their
 * buffers but never reach DSP. Saturation fails explicitly rather than dropping
 * mandatory audio/decoder input or growing an unbounded queue. */
export class WidebandChannelWorker {
  private readonly worker: ChannelWorkerPort;
  private readonly pool = Array.from({ length: CHANNEL_WORKER_SLOTS }, () => [new ArrayBuffer(CHANNEL_MAX_SAMPLES * 4), new ArrayBuffer(CHANNEL_MAX_SAMPLES * 4)] as const);
  private allocatedSlots = CHANNEL_WORKER_SLOTS;
  private generation = 0;
  private closed = false;
  private started = false;
  private resolveReady!: () => void;
  private rejectReady!: (error: Error) => void;
  private readonly ready: Promise<void>;
  private readonly timer: ReturnType<typeof setTimeout>;
  constructor(private readonly deliver: (block: SampleBlock) => void, private readonly error: (error: Error) => void,
    factory = (): ChannelWorkerPort => new Worker(new URL("../workers/channel.worker.ts", import.meta.url), { type: "module" })) {
    this.ready = new Promise<void>((resolve, reject) => { this.resolveReady = resolve; this.rejectReady = reject; });
    void this.ready.catch(() => undefined);
    this.worker = factory();
    this.timer = setTimeout(() => this.fail(new Error("Wideband channel worker startup timed out.")), 2_000);
    this.worker.onerror = () => this.fail(new Error("Wideband channel worker failed."));
    this.worker.onmessage = (event: MessageEvent<ChannelWorkerOutput>) => {
      if (this.closed) return;
      const message = event.data;
      if (message.type === "error") { this.fail(new Error(message.message)); return; }
      if (message.type === "ready") { clearTimeout(this.timer); this.resolveReady(); return; }
      try {
        if (message.generation === this.generation && this.started && message.count > 0) {
          this.deliver({ I: message.I.subarray(0, message.count), Q: message.Q.subarray(0, message.count), frequency: message.frequency });
        }
      } catch (error) { this.fail(error instanceof Error ? error : new Error(String(error))); }
      finally { if (!this.closed) this.pool.push([message.I.buffer, message.Q.buffer]); }
    };
  }
  configure(generation: number, offsetHz: number, sampleRateHz = WIDEBAND_RATE): Promise<void> {
    if (this.closed) throw new Error("Wideband channel worker is closed.");
    // Preserve ~54 ms native buffering when the input rate doubles. Never grow on retunes.
    const slots = sampleRateHz === 9_600_000 ? CHANNEL_WORKER_SLOTS * 2 : CHANNEL_WORKER_SLOTS;
    while (this.allocatedSlots < slots) {
      this.pool.push([new ArrayBuffer(CHANNEL_MAX_SAMPLES * 4), new ArrayBuffer(CHANNEL_MAX_SAMPLES * 4)]);
      this.allocatedSlots++;
    }
    this.generation = generation; this.started = true;
    this.worker.postMessage({ type: "configure", generation, offsetHz, sampleRateHz } satisfies ChannelWorkerInput);
    return this.ready;
  }
  receive(block: SampleBlock, selectedFrequency: number): void {
    if (this.closed || !this.started) return;
    if (block.I.length !== block.Q.length || block.I.length > CHANNEL_MAX_SAMPLES) throw new Error("Wideband input exceeds its fixed block budget.");
    const pair = this.pool.pop();
    if (!pair) throw new Error("Wideband channel processing cannot sustain the input rate; bounded queue exhausted and continuity is unknown.");
    const I = new Float32Array(pair[0], 0, block.I.length), Q = new Float32Array(pair[1], 0, block.Q.length);
    I.set(block.I); Q.set(block.Q);
    this.worker.postMessage({ type: "samples", generation: this.generation, I, Q, frequency: selectedFrequency } satisfies ChannelWorkerInput, [pair[0], pair[1]]);
  }
  reset(): void { this.started = false; }
  close(): void {
    if (this.closed) return;
    this.closed = true; this.started = false; clearTimeout(this.timer);
    this.rejectReady(new Error("Wideband channel worker closed.")); this.worker.terminate(); this.pool.length = 0;
  }
  private fail(error: Error): void { if (!this.closed) { this.close(); this.error(error); } }
}

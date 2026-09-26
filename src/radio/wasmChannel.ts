import { decodeCi8Into } from "./ci8Samples";
import { decodeSc16Q11Into } from "./sc16Samples";
import wasmUrl from "../wasm/pkg/spectrum_analysis.wasm?url";
import { CHANNEL_MAX_SAMPLES } from "./widebandChannel";

export interface ChannelExports extends WebAssembly.Exports {
  memory: WebAssembly.Memory;
  channel_create(): number;
  channel_create_rate(rate: number): number;
  channel_destroy(handle: number): void;
  channel_reset(handle: number, offset: number): number;
  channel_input_i(handle: number): number;
  channel_input_q(handle: number): number;
  channel_process(handle: number, length: number): number;
}
/** Same versioned 31/95 or 15/31/95-tap cascade as the JS reference. Copies into fixed WASM
 * scratch, then back into the existing transferable pair; no extra output queue. */
export class WasmChannelFilter {
  private handle: number;
  constructor(private readonly exports: ChannelExports, rate = 9_600_000) {
    for (const key of ["channel_create", "channel_destroy", "channel_reset", "channel_input_i", "channel_input_q", "channel_process"] as const) {
      if (typeof exports[key] !== "function") throw new Error("Incompatible channel WebAssembly module.");
    }
    if (!(exports.memory instanceof WebAssembly.Memory)) throw new Error("Missing channel WebAssembly memory.");
    if (rate !== 4_800_000 && rate !== 9_600_000 && rate !== 19_200_000) throw new Error("Unsupported compiled channel rate.");
    if (rate !== 9_600_000 && typeof exports.channel_create_rate !== "function") throw new Error("Reload the updated channel WebAssembly module.");
    this.handle = rate === 9_600_000 ? exports.channel_create() : exports.channel_create_rate(rate);
    if (!this.handle) throw new Error("Unable to allocate bounded channel filter.");
  }
  reset(offset: number): void {
    if (!this.handle || !this.exports.channel_reset(this.handle, offset)) throw new Error("Invalid channel filter state or offset.");
  }
  process(I: Float32Array, Q: Float32Array): number {
    if (!this.handle || I.length !== Q.length || I.length > CHANNEL_MAX_SAMPLES) throw new Error("Invalid channel block size or disposed filter.");
    const e = this.exports;
    const i = new Float32Array(e.memory.buffer, e.channel_input_i(this.handle), I.length);
    const q = new Float32Array(e.memory.buffer, e.channel_input_q(this.handle), Q.length);
    i.set(I); q.set(Q);
    const count = e.channel_process(this.handle, I.length);
    I.set(i.subarray(0, count)); Q.set(q.subarray(0, count));
    return count;
  }
  processCi8(bytes: Uint8Array, outputI: Float32Array, outputQ: Float32Array): number {
    if (!this.handle || bytes.length > CHANNEL_MAX_SAMPLES * 2) throw new Error("Invalid native channel block.");
    const e = this.exports;
    const i = new Float32Array(e.memory.buffer, e.channel_input_i(this.handle), CHANNEL_MAX_SAMPLES);
    const q = new Float32Array(e.memory.buffer, e.channel_input_q(this.handle), CHANNEL_MAX_SAMPLES);
    const length = decodeCi8Into(bytes, i, q);
    const count = e.channel_process(this.handle, length);
    if (count > outputI.length || count > outputQ.length) throw new Error("Channel output exceeds capacity.");
    outputI.set(i.subarray(0, count)); outputQ.set(q.subarray(0, count));
    return count;
  }
  processSc16(bytes: Uint8Array, outputI: Float32Array, outputQ: Float32Array): number {
    if (!this.handle || bytes.length > CHANNEL_MAX_SAMPLES * 4) throw new Error("Invalid native channel block.");
    const e = this.exports;
    const i = new Float32Array(e.memory.buffer, e.channel_input_i(this.handle), CHANNEL_MAX_SAMPLES);
    const q = new Float32Array(e.memory.buffer, e.channel_input_q(this.handle), CHANNEL_MAX_SAMPLES);
    const length = decodeSc16Q11Into(bytes, i, q);
    const count = e.channel_process(this.handle, length);
    if (count > outputI.length || count > outputQ.length) throw new Error("Channel output exceeds capacity.");
    outputI.set(i.subarray(0, count)); outputQ.set(q.subarray(0, count));
    return count;
  }
  dispose(): void { if (this.handle) { this.exports.channel_destroy(this.handle); this.handle = 0; } }
}
export async function createWasmChannel(rate = 9_600_000): Promise<WasmChannelFilter> {
  try {
    const response = await fetch(wasmUrl);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const { instance } = await WebAssembly.instantiate(await response.arrayBuffer(), {});
    return new WasmChannelFilter(instance.exports as ChannelExports, rate);
  } catch (error) {
    throw new Error(`${rate / 1_000_000} MS/s requires the optimized channel WebAssembly module. Select 2.4 MS/s or reload after checking asset access. ${String(error)}`, { cause: error });
  }
}

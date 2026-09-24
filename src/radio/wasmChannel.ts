import wasmUrl from "../wasm/pkg/spectrum_analysis.wasm?url";
import { CHANNEL_MAX_SAMPLES } from "./widebandChannel";

export interface ChannelExports extends WebAssembly.Exports {
  memory: WebAssembly.Memory;
  channel_create(): number;
  channel_destroy(handle: number): void;
  channel_reset(handle: number, offset: number): number;
  channel_input_i(handle: number): number;
  channel_input_q(handle: number): number;
  channel_process(handle: number, length: number): number;
}
/** Same versioned 31/95-tap cascade as the JS reference. Copies into fixed WASM
 * scratch, then back into the existing transferable pair; no extra output queue. */
export class WasmChannelFilter {
  private handle: number;
  constructor(private readonly exports: ChannelExports) {
    for (const key of ["channel_create", "channel_destroy", "channel_reset", "channel_input_i", "channel_input_q", "channel_process"] as const) {
      if (typeof exports[key] !== "function") throw new Error("Incompatible channel WebAssembly module.");
    }
    if (!(exports.memory instanceof WebAssembly.Memory)) throw new Error("Missing channel WebAssembly memory.");
    this.handle = exports.channel_create();
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
  dispose(): void { if (this.handle) { this.exports.channel_destroy(this.handle); this.handle = 0; } }
}
export async function createWasmChannel(): Promise<WasmChannelFilter> {
  try {
    const response = await fetch(wasmUrl);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const { instance } = await WebAssembly.instantiate(await response.arrayBuffer(), {});
    return new WasmChannelFilter(instance.exports as ChannelExports);
  } catch (error) {
    throw new Error(`9.6 MS/s requires the optimized channel WebAssembly module. Select 4.8 MS/s or reload after checking asset access. ${String(error)}`, { cause: error });
  }
}

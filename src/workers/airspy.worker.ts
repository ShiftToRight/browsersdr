import { AirspyConversion } from "../radio/airspyConversion";
import type { AirspySettings } from "../radio/airspySettings";
let conversion: AirspyConversion | undefined;
let generation = -1;
self.onmessage = (
  event: MessageEvent<
    | {
        type: "configure";
        generation: number;
        rate: number;
        settings: AirspySettings;
      }
    | { type: "samples"; generation: number; bytes: Uint8Array<ArrayBuffer> }
  >,
) => {
  const message = event.data;
  try {
    if (message.type === "configure") {
      generation = message.generation;
      conversion = new AirspyConversion(message.settings, message.rate);
      // Warm the actual conversion/decimation path before USB starts, then reset
      // all histories. No generated warm-up samples reach spectrum or audio.
      const warm = new Uint8Array(message.settings.packing ? 49152 : 65536);
      const view = new DataView(warm.buffer);
      const adc = (n: number) => (n * 73 + n * n * 19) % 4096;
      if (message.settings.packing) {
        for (let n = 0, sample = 0; n < warm.length; n += 12, sample += 8) {
          const v = Array.from({ length: 8 }, (_, k) => adc(sample + k));
          view.setUint32(n, (v[0]! << 20) | (v[1]! << 8) | (v[2]! >>> 4), true);
          view.setUint32(
            n + 4,
            ((v[2]! & 15) << 28) | (v[3]! << 16) | (v[4]! << 4) | (v[5]! >>> 8),
            true,
          );
          view.setUint32(
            n + 8,
            ((v[5]! & 255) << 24) | (v[6]! << 12) | v[7]!,
            true,
          );
        }
      } else
        for (let n = 0; n < warm.length; n += 2)
          view.setUint16(n, adc(n / 2), true);
      for (let n = 0; n < 64; n++) conversion.process(warm);
      conversion.reset();
      self.postMessage({ type: "ready", generation });
    } else {
      const before = performance.now();
      const block =
        generation === message.generation
          ? conversion!.process(message.bytes)
          : { I: new Float32Array(0), Q: new Float32Array(0) };
      self.postMessage(
        {
          type: "samples",
          generation: message.generation,
          processingMs: performance.now() - before,
          ...block,
        },
        {
          transfer: [
            block.I.buffer as ArrayBuffer,
            block.Q.buffer as ArrayBuffer,
          ],
        },
      );
    }
  } catch (error) {
    self.postMessage({
      type: "error",
      generation: message.generation,
      message: String(error),
    });
  }
};

import type { SignalSource } from "@jtarrio/signals/radio/signal_source.js";
import {
  DEFAULT_RTL_INPUT,
  rtlDeviceFrequency,
  type RtlInputSettings,
} from "./rtlInput";
/** Translate both commands and delivered coordinates. Original CU8 bytes stay
 * untouched; acquisition metadata records the translation separately. */
export class RtlRfSource implements SignalSource {
  input: RtlInputSettings = { ...DEFAULT_RTL_INPUT };
  constructor(private readonly source: SignalSource) {}
  setSampleRate(rate: number) {
    return this.source.setSampleRate(rate);
  }
  setParameter<V>(name: string, value: V) {
    return this.source.setParameter(name, value);
  }
  async setCenterFrequency(rfHz: number) {
    return (
      (await this.source.setCenterFrequency(
        rtlDeviceFrequency(rfHz, this.input),
      )) - this.input.converterOffsetHz
    );
  }
  async readSamples(length: number) {
    const block = await this.source.readSamples(length);
    return {
      ...block,
      frequency: block.frequency - this.input.converterOffsetHz,
    };
  }
  startReceiving() {
    return this.source.startReceiving();
  }
  async close() {
    try {
      await this.source.setParameter("bias_tee", false);
    } finally {
      await this.source.close();
    }
  }
}

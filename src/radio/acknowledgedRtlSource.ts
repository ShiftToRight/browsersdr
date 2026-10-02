import { RtlSource, type RtlParameter } from "@jtarrio/webrtlsdr/radio/source.js";
import type { RtlDevice } from "@jtarrio/webrtlsdr/rtlsdr/rtldevice.js";
import { Cu8Float32Converter } from "./cu8";

/** Signals caches setParameter's result; the upstream RTL setters return void. */
export class AcknowledgedRtlSource extends RtlSource {
  private readonly canonicalConverter = new Cu8Float32Converter();
  private readonly acknowledgedCenters = new Map<number, number>();

  constructor(private readonly device: RtlDevice) { super(device); }

  override async setCenterFrequency(frequency: number): Promise<number> {
    const acknowledged = await this.device.setCenterFrequency(frequency);
    // WebRTLSDR labels each block with the requested center even though its
    // setter returns the tuner PLL's acknowledged center. BrowserSDR routes
    // and rejects stale blocks by acknowledged center, so preserve the block's
    // generation while translating that requested label to the matching
    // acknowledged value. Keep a few prior scan centers for reads in flight.
    this.acknowledgedCenters.delete(frequency);
    this.acknowledgedCenters.set(frequency, acknowledged);
    while (this.acknowledgedCenters.size > 8) {
      const oldest = this.acknowledgedCenters.keys().next().value;
      if (oldest === undefined) break;
      this.acknowledgedCenters.delete(oldest);
    }
    return acknowledged;
  }

  override async readSamples(length: number) {
    const block = await this.device.readSamples(length);
    const iq = this.canonicalConverter.convert(block.data);
    return {
      I: iq.I,
      Q: iq.Q,
      frequency:
        this.acknowledgedCenters.get(block.frequency) ?? block.frequency,
      data: { directSampling: block.directSampling },
    };
  }

  override async setParameter<V>(parameter: RtlParameter, value: V): Promise<V | void> {
    await super.setParameter(parameter, value);
    switch (parameter) {
      // The device getter reports the acknowledged request, not calibrated gain.
      case "gain": return this.device.getGain() as V;
      case "frequency_correction": return this.device.getFrequencyCorrection() as V;
      case "direct_sampling_method": return this.device.getDirectSamplingMethod() as V;
      case "bias_tee": return this.device.isBiasTeeEnabled() as V;
    }
  }
}

import { RtlSource, type RtlParameter } from "@jtarrio/webrtlsdr/radio/source.js";
import type { RtlDevice } from "@jtarrio/webrtlsdr/rtlsdr/rtldevice.js";

/** Signals caches setParameter's result; the upstream RTL setters return void. */
export class AcknowledgedRtlSource extends RtlSource {
  constructor(private readonly device: RtlDevice) { super(device); }

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

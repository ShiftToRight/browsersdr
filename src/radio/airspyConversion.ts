import { RecordingConvolver } from "./recordingConvolver";
import { WasmHalfBandStage } from "./wasmHalfBand";
import type { AirspySettings } from "./airspySettings";

/** Offset-binary real ADC -> centered complex baseband, using libairspy's
 * Fs/4 phase convention. Standard coefficients are MIT licensed (see notices).
 * Separate retained I FIR and Q delay implement the real half-band polyphase
 * branches without discarding 12-bit input precision. */
const standard = [
  -0.0009986062729475101, 0.001695637278417295, -0.003054430179754289,
  0.005055504379767936, -0.007901319195893647, 0.01187335705104772,
  -0.01741115937993007, 0.02530481742756877, -0.03722522520455922,
  0.0575332869970043, -0.1023274620042594, 0.3170344725089474,
  0.3170344725089474, -0.1023274620042594, 0.0575332869970043,
  -0.03722522520455922, 0.02530481742756877, -0.01741115937993007,
  0.01187335705104772, -0.007901319195893647, 0.005055504379767936,
  -0.003054430179754289, 0.001695637278417295, -0.0009986062729475101,
];
export class AirspyConversion {
  private readonly convolver = new RecordingConvolver();
  private readonly taps: Float32Array;
  private readonly history: Float32Array;
  private readonly delay: Float32Array;
  private delayIndex = 0;
  private average = 0;
  private phase = 0;
  private carry = new Uint8Array(0);
  private readonly stages: WasmHalfBandStage[] = [];
  constructor(
    private readonly settings: AirspySettings,
    rate: number,
  ) {
    if (settings.conversionFilter === "standard")
      this.taps = Float32Array.from(standard);
    else {
      // Independent 95-tap Blackman half-band, nonzero even polyphase branch.
      this.taps = Float32Array.from({ length: 48 }, (_, index) => {
        const n = index * 2,
          x = n - 47;
        return (
          (Math.sin((Math.PI * x) / 2) / (Math.PI * x)) *
          (0.42 -
            0.5 * Math.cos((2 * Math.PI * n) / 94) +
            0.08 * Math.cos((4 * Math.PI * n) / 94))
        );
      });
    }
    this.convolver.setCoefs(this.taps);
    this.history = new Float32Array(this.taps.length - 1 + 16384);
    this.delay = new Float32Array(this.taps.length / 2);
    for (let factor = 1; factor < settings.decimation; factor *= 2)
      this.stages.push(
        new WasmHalfBandStage(
          0,
          rate / factor,
          95,
          true,
          () => new RecordingConvolver(),
        ),
      );
  }
  reset(): void {
    this.history.fill(0);
    this.delay.fill(0);
    this.delayIndex = 0;
    this.average = 0;
    this.phase = 0;
    this.carry = new Uint8Array(0);
    for (const stage of this.stages) stage.reset(0);
  }
  process(input: Uint8Array): { I: Float32Array; Q: Float32Array } {
    let bytes = input;
    if (this.carry.length) {
      bytes = new Uint8Array(this.carry.length + input.length);
      bytes.set(this.carry);
      bytes.set(input, this.carry.length);
    }
    const group = this.settings.packing ? 12 : 8;
    const length = bytes.length - (bytes.length % group);
    this.carry = bytes.slice(length);
    const count = this.settings.packing ? length / 3 : length / 4;
    if (count > 16384)
      throw new Error("Airspy conversion block exceeds its fixed budget.");
    const I = new Float32Array(count),
      Q = new Float32Array(count);
    const view = new DataView(bytes.buffer, bytes.byteOffset, length);
    const history = this.taps.length - 1;
    const adc = (value: number, index: number) => {
      if (value > 4095)
        throw new Error("Airspy unpacked ADC sample exceeds 12 bits.");
      const centered = (value - 2048) / 2048;
      const sample = centered - this.average;
      this.average += 0.01 * sample;
      const translated = (this.phase < 2 ? -1 : 1) * sample;
      this.phase = (this.phase + 1) % 4;
      if (index % 2 === 0) this.history[history + (index >> 1)] = translated;
      else {
        const out = this.delay[this.delayIndex]!;
        this.delay[this.delayIndex] = translated * 0.5;
        this.delayIndex = (this.delayIndex + 1) % this.delay.length;
        Q[index >> 1] = out;
      }
    };
    if (this.settings.packing) {
      for (let offset = 0, n = 0; offset < length; offset += 12) {
        const a = view.getUint32(offset, true),
          b = view.getUint32(offset + 4, true),
          c = view.getUint32(offset + 8, true);
        adc(a >>> 20, n++);
        adc((a >>> 8) & 4095, n++);
        adc(((a & 255) << 4) | (b >>> 28), n++);
        adc((b >>> 16) & 4095, n++);
        adc((b >>> 4) & 4095, n++);
        adc(((b & 15) << 8) | (c >>> 24), n++);
        adc((c >>> 12) & 4095, n++);
        adc(c & 4095, n++);
      }
    } else
      for (let n = 0; n < count * 2; n++) adc(view.getUint16(n * 2, true), n);
    I.set(
      this.convolver.convolveWithStride(
        this.history.subarray(0, history + count),
        count,
        1,
        0,
      ),
    );
    this.history.copyWithin(0, count, count + history);
    let produced = count;
    for (const stage of this.stages)
      produced = stage.process(
        I.subarray(0, produced),
        Q.subarray(0, produced),
      );
    return { I: I.slice(0, produced), Q: Q.slice(0, produced) };
  }
}

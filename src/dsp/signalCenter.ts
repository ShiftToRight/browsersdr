import { SpectrumAccumulator } from "./spectrumMath";
import { captureEdgeGuardHz } from "../radio/captureSpan";
import type { SourceSessionMetadata } from "../radio/types";

export interface SignalCenterResult {
  kind: "estimate" | "no-signal" | "failure";
  offsetHz?: number;
  toleranceHz?: number;
  message: string;
  diagnostics?: SignalCenterDiagnostics;
}
export interface SignalCenterDiagnostics {
  offsetHz?: number;
  envelopeRatio?: number;
  localEnvelopeRatio?: number;
  phaseScatterHz?: number;
  peakSnrDb?: number;
  integratedSnrDb?: number;
  outsidePowerRatio?: number;
  edgePowerRatio?: number;
  spectralCenterHz?: number;
  measurementBandwidthHz?: number;
  refinement?: SignalCenterDiagnostics;
}
export const CENTER_MEASUREMENT_SECONDS = 0.6;
export function centerSearchHz(metadata: SourceSessionMetadata): number {
  return metadata.mode === "WBFM"
    ? 25_000
    : Math.min(5_000, metadata.channelBandwidthHz * 0.35);
}

/** One bounded, raw-IQ measurement. A wider filter than the audible channel
 * avoids pulling an off-center FM station toward a clipped playback passband.
 * FM error is the mean complex phase increment in Hz, before DC removal.
 * Spectrum checks are independent confidence gates, never the FM estimate. */
export class SignalCenterEstimator {
  private readonly decimation: number;
  readonly rate: number;
  private readonly cutoff: number;
  private readonly taps: Float64Array;
  private readonly historyI: Float64Array;
  private readonly historyQ: Float64Array;
  private cursor = 0;
  private inputCount = 0;
  private outputCount = 0;
  private oscillatorI = 1;
  private oscillatorQ = 0;
  private readonly rotationI: number;
  private readonly rotationQ: number;
  private readonly windowI = new Float32Array(4096);
  private readonly windowQ = new Float32Array(4096);
  private windowCount = 0;
  private readonly spectrum = new SpectrumAccumulator(4096, 1);
  private readonly powers = new Float64Array(4096);
  private spectra = 0;
  private readonly carrierPeaks: number[] = [];
  private amplitudePower = 0;
  private amplitudePowerSquared = 0;
  private envelopeBlockPower = 0;
  private envelopeBlockPowerSquared = 0;
  private envelopeBlockCount = 0;
  private readonly envelopeRatios: number[] = [];
  private previousI = 0;
  private previousQ = 0;
  private phaseSum = 0;
  private phaseCount = 0;
  private blockSum = 0;
  private blockCount = 0;
  private readonly blockMeans: number[] = [];
  private readonly search: number;
  private result?: SignalCenterResult;
  private readonly diagnostics: SignalCenterDiagnostics = {};
  private readonly measuredI: Float32Array;
  private readonly measuredQ: Float32Array;

  constructor(
    readonly metadata: SourceSessionMetadata,
    private readonly refineFm = true,
  ) {
    if (!["AM", "NBFM", "WBFM"].includes(metadata.mode))
      throw new Error("Center signal supports AM, NBFM and WBFM.");
    this.search = centerSearchHz(metadata);
    this.cutoff = metadata.channelBandwidthHz * 0.75 + this.search;
    this.decimation = Math.max(
      1,
      Math.floor(
        metadata.actualSampleRateHz / Math.max(16_000, this.cutoff * 4),
      ),
    );
    this.rate = metadata.actualSampleRateHz / this.decimation;
    const stored =
      this.refineFm && metadata.mode === "WBFM"
        ? Math.ceil(this.rate * CENTER_MEASUREMENT_SECONDS)
        : 0;
    this.measuredI = new Float32Array(stored);
    this.measuredQ = new Float32Array(stored);
    // Polyphase decimation evaluates only retained outputs. Storage and work are
    // bounded by the native rate and the 600 ms capture, with no audio mutation.
    const count = this.decimation * 24 + 1;
    this.taps = new Float64Array(count);
    this.historyI = new Float64Array(count * 2);
    this.historyQ = new Float64Array(count * 2);
    let sum = 0;
    const normalized = this.cutoff / metadata.actualSampleRateHz;
    for (let n = 0; n < count; n++) {
      const x = n - (count - 1) / 2;
      const value =
        (x === 0
          ? 2 * normalized
          : Math.sin(2 * Math.PI * normalized * x) / (Math.PI * x)) *
        (0.42 -
          0.5 * Math.cos((2 * Math.PI * n) / (count - 1)) +
          0.08 * Math.cos((4 * Math.PI * n) / (count - 1)));
      this.taps[n] = value;
      sum += value;
    }
    for (let n = 0; n < count; n++) this.taps[n] = this.taps[n]! / sum;
    const angle =
      (-2 *
        Math.PI *
        (metadata.selectedChannelFrequencyHz -
          metadata.hardwareCenterFrequencyHz)) /
      metadata.actualSampleRateHz;
    this.rotationI = Math.cos(angle);
    this.rotationQ = Math.sin(angle);
  }

  accept(
    I: Float32Array,
    Q: Float32Array,
    discontinuity = false,
  ): SignalCenterResult | undefined {
    if (this.result) return this.result;
    if (discontinuity)
      return (this.result = {
        kind: "failure",
        message: "Samples were interrupted. Try again after reception settles.",
      });
    const count = this.taps.length;
    for (let n = 0; n < Math.min(I.length, Q.length); n++) {
      const i = I[n]! * this.oscillatorI - Q[n]! * this.oscillatorQ;
      const q = I[n]! * this.oscillatorQ + Q[n]! * this.oscillatorI;
      const nextI =
        this.oscillatorI * this.rotationI - this.oscillatorQ * this.rotationQ;
      this.oscillatorQ =
        this.oscillatorI * this.rotationQ + this.oscillatorQ * this.rotationI;
      this.oscillatorI = nextI;
      this.historyI[this.cursor] = this.historyI[this.cursor + count] = i;
      this.historyQ[this.cursor] = this.historyQ[this.cursor + count] = q;
      this.cursor = (this.cursor + 1) % count;
      this.inputCount++;
      if (this.inputCount % 4096 === 0) {
        const norm = Math.hypot(this.oscillatorI, this.oscillatorQ);
        this.oscillatorI /= norm;
        this.oscillatorQ /= norm;
      }
      if (
        this.inputCount % this.decimation !== 0 ||
        this.inputCount < count * 2
      )
        continue;
      let outI = 0,
        outQ = 0;
      for (let k = 0; k < count; k++) {
        outI += this.historyI[this.cursor + k]! * this.taps[k]!;
        outQ += this.historyQ[this.cursor + k]! * this.taps[k]!;
      }
      this.windowI[this.windowCount] = outI;
      this.windowQ[this.windowCount++] = outQ;
      if (this.windowCount === 4096) {
        const bins = this.spectrum.addWindow(this.windowI, this.windowQ)!;
        for (let k = 0; k < bins.length; k++)
          this.powers[k] = this.powers[k]! + 10 ** (bins[k]! / 10);
        let peak = 2048;
        for (let k = 1; k < 4095; k++)
          if (
            Math.abs(((k - 2048) * this.rate) / 4096) < this.cutoff * 0.9 &&
            bins[k]! > bins[peak]!
          )
            peak = k;
        this.carrierPeaks.push(peak);
        this.spectra++;
        this.windowCount = 0;
      }
      if (this.outputCount > 0) {
        const hz =
          (Math.atan2(
            outQ * this.previousI - outI * this.previousQ,
            outI * this.previousI + outQ * this.previousQ,
          ) *
            this.rate) /
          (2 * Math.PI);
        this.phaseSum += hz;
        this.phaseCount++;
        this.blockSum += hz;
        this.blockCount++;
        if (this.blockCount >= this.rate * 0.05) {
          this.blockMeans.push(this.blockSum / this.blockCount);
          this.blockSum = 0;
          this.blockCount = 0;
        }
      }
      const amplitudePower = outI * outI + outQ * outQ;
      if (this.outputCount < this.measuredI.length) {
        this.measuredI[this.outputCount] = outI;
        this.measuredQ[this.outputCount] = outQ;
      }
      this.amplitudePower += amplitudePower;
      this.amplitudePowerSquared += amplitudePower * amplitudePower;
      this.envelopeBlockPower += amplitudePower;
      this.envelopeBlockPowerSquared += amplitudePower * amplitudePower;
      if (++this.envelopeBlockCount >= this.rate * 0.005) {
        this.envelopeRatios.push(
          (this.envelopeBlockPowerSquared * this.envelopeBlockCount) /
            Math.max(1e-24, this.envelopeBlockPower ** 2),
        );
        this.envelopeBlockPower = this.envelopeBlockPowerSquared = 0;
        this.envelopeBlockCount = 0;
      }
      this.previousI = outI;
      this.previousQ = outQ;
      this.outputCount++;
      if (this.outputCount >= this.rate * CENTER_MEASUREMENT_SECONDS)
        return (this.result = this.finish());
    }
    return undefined;
  }

  private finish(): SignalCenterResult {
    const reject = (message: string): SignalCenterResult => ({
      kind: "no-signal",
      message: `No clear signal: ${message}`,
      diagnostics: this.diagnostics,
    });
    if (this.spectra < 2 || this.blockMeans.length < 8)
      return reject("measurement too short.");
    const binHz = this.rate / 4096;
    const power = Array.from(this.powers, (value) => value / this.spectra);
    const noiseBins = power
      .filter(
        (_, n) =>
          Math.abs((n - 2048) * binHz) > this.cutoff * 0.65 &&
          Math.abs((n - 2048) * binHz) < this.cutoff * 0.85,
      )
      .sort((a, b) => a - b);
    const noise = Math.max(
      1e-12,
      noiseBins[Math.floor(noiseBins.length / 2)] ?? 1e-12,
    );
    let peak = 2048;
    for (let n = 1; n < 4095; n++)
      if (
        Math.abs((n - 2048) * binHz) <= this.cutoff * 0.9 &&
        power[n]! > power[peak]!
      )
        peak = n;
    let offset: number;
    const tolerance = this.metadata.mode === "WBFM" ? 500 : Math.max(25, binHz);
    if (this.metadata.mode === "AM") {
      if (power[peak]! / noise < 100) return reject("carrier is too weak.");
      const a = Math.log(power[peak - 1]!),
        b = Math.log(power[peak]!),
        c = Math.log(power[peak + 1]!);
      const fraction = Math.max(
        -0.5,
        Math.min(0.5, (0.5 * (a - c)) / (a - 2 * b + c)),
      );
      offset = (peak - 2048 + fraction) * binHz;
      const peakScatter = Math.sqrt(
        this.carrierPeaks.reduce((sum, n) => sum + (n - peak) ** 2, 0) /
          this.carrierPeaks.length,
      );
      if (peakScatter > 1.5)
        return reject("carrier is unstable or intermittent.");
      // Strong symmetric sidebands are valid ordinary AM, including 100% depth.
      // An unmatched carrier elsewhere in the local passband is ambiguous.
      for (let n = 1; n < 4095; n++) {
        if (
          Math.abs(n - peak) > 4 &&
          Math.abs((n - 2048) * binHz) < this.cutoff * 0.9 &&
          power[n]! > power[peak]! * 0.2 &&
          power[n]! >= power[n - 1]! &&
          power[n]! >= power[n + 1]!
        ) {
          const mirror = 2 * peak - n;
          const mirrored = Math.max(
            ...power.slice(Math.max(0, mirror - 1), Math.min(4096, mirror + 2)),
          );
          if (mirrored < power[n]! * 0.6 || mirrored > power[n]! * 1.7)
            return reject("multiple nearby carriers.");
        }
      }
    } else {
      offset = this.phaseSum / this.phaseCount;
      const envelopeRatio =
        (this.amplitudePowerSquared * this.outputCount) /
        (this.amplitudePower * this.amplitudePower);
      this.diagnostics.offsetHz = offset;
      this.diagnostics.measurementBandwidthHz =
        this.metadata.channelBandwidthHz;
      this.diagnostics.envelopeRatio = envelopeRatio;
      this.diagnostics.localEnvelopeRatio =
        this.envelopeRatios.reduce((sum, value) => sum + value, 0) /
        this.envelopeRatios.length;
      let inside = 0,
        outside = 0,
        edge = 0,
        centroid = 0;
      const half = this.metadata.channelBandwidthHz / 2;
      for (let n = 0; n < 4096; n++) {
        const f = (n - 2048) * binHz;
        const p = Math.max(0, power[n]! - noise);
        if (Math.abs(f) > this.cutoff * 0.95) continue;
        if (Math.abs(f - offset) <= half) {
          inside += p;
          centroid += f * p;
        } else outside += p;
        if (Math.abs(f) >= this.cutoff * 0.8) edge += p;
      }
      this.diagnostics.peakSnrDb = 10 * Math.log10(power[peak]! / noise);
      this.diagnostics.integratedSnrDb =
        10 * Math.log10(inside / ((noise * (2 * half)) / binHz));
      this.diagnostics.outsidePowerRatio = outside / inside;
      this.diagnostics.edgePowerRatio = edge / inside;
      this.diagnostics.spectralCenterHz = centroid / inside;
      const scatter = Math.sqrt(
        this.blockMeans.reduce((sum, mean) => sum + (mean - offset) ** 2, 0) /
          this.blockMeans.length,
      );
      this.diagnostics.phaseScatterHz = scatter;
      if (power[peak]! < noise * 20) return reject("signal is too weak.");
      if (outside > inside * 0.12 || edge > inside * 0.015)
        return reject("adjacent signal or clipped passband.");
      if (
        Math.abs(centroid / inside - offset) >
        Math.max(half * 0.18, tolerance * 2)
      )
        return reject("frequency and spectrum disagree.");
      if (scatter > Math.max(tolerance * 1.5, half * 0.04))
        return reject("frequency is unstable; wait for a steady signal.");
      if (!Number.isFinite(offset) || Math.abs(offset) > this.search)
        return reject("signal lies outside the local correction range.");

      // A broadcast FM channel can occupy far less than its configured 150 kHz
      // during quiet programme material. A wide discriminator then integrates
      // mostly noise; envelope moments and SNR over the entire channel reject
      // a coherent local signal. Identify occupied power above the noise floor
      // and remeasure fresh stored IQ through a candidate-centered filter.
      // The broad pass still guards against neighbors, capture clipping and an
      // unstable/remote candidate. Its phase mean seeds the filter, never an
      // FFT peak. A second independent phase estimate must agree with it.
      const occupied = power
        .flatMap((p, n) => {
          const distance = Math.abs((n - 2048) * binHz - offset);
          return distance <= half && p > noise * 4
            ? [{ distance, power: p - noise * 4 }]
            : [];
        })
        .sort((a, b) => a.distance - b.distance);
      const occupiedPower = occupied.reduce((sum, bin) => sum + bin.power, 0);
      let running = 0,
        radius = half;
      for (const bin of occupied) {
        running += bin.power;
        if (running >= occupiedPower * 0.98) {
          radius = bin.distance;
          break;
        }
      }
      const candidateBandwidth = Math.max(
        30_000,
        2 * (radius + Math.max(5_000, radius * 0.2)),
      );
      const weakWideChannel = inside < noise * ((2 * half) / binHz) * 12;
      if (
        this.refineFm &&
        this.metadata.mode === "WBFM" &&
        occupiedPower > 0 &&
        candidateBandwidth < this.metadata.channelBandwidthHz * 0.75 &&
        (weakWideChannel || envelopeRatio > 1.3)
      ) {
        const fine = new SignalCenterEstimator(
          {
            ...this.metadata,
            actualSampleRateHz: this.rate,
            requestedSampleRateHz: this.rate,
            hardwareCenterFrequencyHz: this.metadata.selectedChannelFrequencyHz,
            selectedChannelFrequencyHz:
              this.metadata.selectedChannelFrequencyHz + offset,
            channelBandwidthHz: candidateBandwidth,
          },
          false,
        );
        const refined =
          fine.accept(this.measuredI, this.measuredQ) ?? fine.finish();
        this.diagnostics.refinement = refined.diagnostics;
        if (refined.kind !== "estimate" || refined.offsetHz === undefined)
          return { ...refined, diagnostics: this.diagnostics };
        // Noise can bias the wide discriminator toward zero even while its
        // short-block means are steady. In that case require the isolated
        // phase mean to agree with BOTH spectra within the stated tolerance,
        // and keep movement much smaller than the original channel width.
        const spectralAgreement =
          Math.abs(offset + refined.offsetHz - centroid / inside) <=
            tolerance &&
          Math.abs(
            refined.offsetHz -
              (refined.diagnostics?.spectralCenterHz ?? Infinity),
          ) <= tolerance &&
          Math.abs(refined.offsetHz) <= Math.min(this.search / 4, half * 0.05);
        if (Math.abs(refined.offsetHz) > tolerance && !spectralAgreement)
          return reject("wide and isolated frequency measurements disagree.");
        offset += refined.offsetHz;
      } else {
        if (weakWideChannel) return reject("signal is too weak.");
        // Normalize slow RF gain/fading over short blocks, while retaining the
        // original fast-envelope interference threshold. Require occupied FM
        // bandwidth so close beating unmodulated carriers cannot use this path.
        const normalizedEnvelope =
          this.metadata.mode === "WBFM" && radius > 5_000
            ? this.diagnostics.localEnvelopeRatio!
            : envelopeRatio;
        if (normalizedEnvelope > 1.3)
          return reject("overlapping signals or unstable signal envelope.");
      }
      // A narrow unmodulated line at the hardware center is indistinguishable
      // from a tuner DC spur; deliberately refuse to identify it as a station.
    }
    if (!Number.isFinite(offset) || Math.abs(offset) > this.search)
      return reject("signal lies outside the local correction range.");
    const dc =
      this.metadata.hardwareCenterFrequencyHz -
      this.metadata.selectedChannelFrequencyHz;
    if (Math.abs(offset - dc) < Math.max(binHz * 2, 50)) {
      let nearDc = 0,
        all = 0;
      for (let n = 0; n < 4096; n++) {
        const f = (n - 2048) * binHz;
        if (Math.abs(f) > this.cutoff) continue;
        all += power[n]!;
        if (Math.abs(f - dc) < binHz * 3) nearDc += power[n]!;
      }
      if (nearDc > all * 0.6)
        return reject(
          "possible hardware-center DC artifact. Tune slightly away and retry.",
        );
    }
    const finalNativeOffset =
      this.metadata.selectedChannelFrequencyHz +
      offset -
      this.metadata.hardwareCenterFrequencyHz;
    const usable =
      this.metadata.actualSampleRateHz / 2 -
      this.metadata.channelBandwidthHz / 2 -
      captureEdgeGuardHz(this.metadata.actualSampleRateHz);
    // The entire wider measurement passband must also fit, to avoid false
    // confidence when the acquisition itself clipped the selected signal.
    if (
      Math.abs(
        this.metadata.selectedChannelFrequencyHz -
          this.metadata.hardwareCenterFrequencyHz,
      ) +
        this.cutoff >
        this.metadata.actualSampleRateHz / 2 -
          captureEdgeGuardHz(this.metadata.actualSampleRateHz) ||
      Math.abs(finalNativeOffset) > usable
    )
      return reject(
        "signal is near the captured edge. Move the capture center and retry.",
      );
    return {
      kind: "estimate",
      offsetHz: offset,
      toleranceHz: tolerance,
      message: "Stable local signal measured.",
      diagnostics: this.diagnostics,
    };
  }
}

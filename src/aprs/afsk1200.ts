import { HdlcDeframer, type HdlcCandidate } from "./hdlc";

interface TimingCandidate {
  deframer: HdlcDeframer;
  previousTone?: number;
}

interface TimingBank {
  decisionRateHz: number;
  resamplePhase: number;
  decisionIndex: number;
  candidates: TimingCandidate[];
}

/** Non-coherent Bell-202 detector with eight symbol-phase hypotheses. */
export class Bell202Receiver {
  private readonly windowLength: number;
  private readonly rings: Float64Array[];
  private readonly sums = new Float64Array(4);
  private readonly banks: TimingBank[];
  private ringIndex = 0;
  private sampleCount = 0;

  constructor(private readonly sampleRateHz: number) {
    this.windowLength = Math.max(8, Math.round(sampleRateHz / 1200));
    this.rings = Array.from(
      { length: 4 },
      () => new Float64Array(this.windowLength),
    );
    this.banks = [1194, 1200, 1206].map((baud) => ({
      decisionRateHz: baud * 8,
      resamplePhase: 0,
      decisionIndex: 0,
      candidates: Array.from({ length: 8 }, () => ({
        deframer: new HdlcDeframer(),
      })),
    }));
  }

  reset(): void {
    for (const ring of this.rings) ring.fill(0);
    this.sums.fill(0);
    this.ringIndex = 0;
    this.sampleCount = 0;
    for (const bank of this.banks) {
      bank.resamplePhase = 0;
      bank.decisionIndex = 0;
      for (const candidate of bank.candidates) {
        candidate.deframer.reset();
        candidate.previousTone = undefined;
      }
    }
  }

  process(
    samples: Float32Array,
    firstInputSampleIndex: number,
    inputSamplesPerOutput: number,
  ): HdlcCandidate[] {
    const results: HdlcCandidate[] = [];
    for (let index = 0; index < samples.length; index++) {
      const sample = samples[index]!;
      const absolute = this.sampleCount++;
      const angleMark = (2 * Math.PI * 1200 * absolute) / this.sampleRateHz;
      const angleSpace = (2 * Math.PI * 2200 * absolute) / this.sampleRateHz;
      const terms = [
        sample * Math.cos(angleMark),
        sample * Math.sin(angleMark),
        sample * Math.cos(angleSpace),
        sample * Math.sin(angleSpace),
      ];
      for (let term = 0; term < 4; term++) {
        const ring = this.rings[term]!;
        this.sums[term] =
          this.sums[term]! + terms[term]! - ring[this.ringIndex]!;
        ring[this.ringIndex] = terms[term]!;
      }
      this.ringIndex = (this.ringIndex + 1) % this.windowLength;
      const mark = this.sums[0]! ** 2 + this.sums[1]! ** 2;
      const space = this.sums[2]! ** 2 + this.sums[3]! ** 2;
      const tone = mark >= space ? 1 : 0;
      for (const bank of this.banks) {
        bank.resamplePhase += bank.decisionRateHz;
        if (
          bank.resamplePhase < this.sampleRateHz ||
          absolute < this.windowLength
        )
          continue;
        bank.resamplePhase -= this.sampleRateHz;
        const phase = bank.decisionIndex++ & 7;
        const candidate = bank.candidates[phase]!;
        if (candidate.previousTone !== undefined) {
          const bit = candidate.previousTone === tone ? 1 : 0;
          const sampleIndex =
            firstInputSampleIndex + index * inputSamplesPerOutput;
          results.push(...candidate.deframer.push(bit, sampleIndex));
        }
        candidate.previousTone = tone;
      }
    }
    return results;
  }
}

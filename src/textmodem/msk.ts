/** Original noncoherent ACARS MSK detector. The real AM envelope is resampled
 * to 12 kHz. A sinusoid obeys x[n]+x[n-2]=2 cos(w)x[n-1]; compare prediction
 * residuals at 1200/2400 Hz, then integrate over each five-sample bit interval.
 * Five clock hypotheses avoid assuming the burst's start sample. Each owns
 * its NRZI/framing state; only protocol-validated messages are published. */
export class AcarsMskDemodulator {
  private previous = 0;
  private previous2 = 0;
  private inputPrevious = 0;
  private inputIndex = 0;
  private nextOutput = 0;
  private outputIndex = 0;
  private metrics = new Float64Array(5);
  private signal = new Float64Array(5);
  private states = new Uint8Array(5);
  level = 0;
  constructor(
    private readonly rate: number,
    private readonly output: (bit: number, hypothesis: number) => void,
  ) {}
  push(sample: number): void {
    const index = this.inputIndex++;
    if (index >= this.nextOutput) {
      const fraction = Math.max(0, Math.min(1, this.nextOutput - (index - 1)));
      this.receive(
        this.inputPrevious + fraction * (sample - this.inputPrevious),
      );
      this.nextOutput += this.rate / 12000;
    }
    this.inputPrevious = sample;
  }
  private receive(value: number): void {
    const eLow = value + this.previous2 - 1.618033988749895 * this.previous;
    const eHigh = value + this.previous2 - 0.618033988749895 * this.previous;
    const metric = eLow * eLow - eHigh * eHigh;
    this.previous2 = this.previous;
    this.previous = value;
    for (let phase = 0; phase < 5; phase++) {
      this.metrics[phase] = this.metrics[phase]! + metric;
      this.signal[phase] = this.signal[phase]! + value * value;
      if (this.outputIndex % 5 !== phase) continue;
      this.level = Math.sqrt(this.signal[phase]! / 5);
      // 1200 Hz causes an NRZI transition, 2400 Hz retains the state.
      if (this.metrics[phase]! < 0)
        this.states[phase] = 1 - this.states[phase]!;
      this.output(this.states[phase]!, phase);
      this.metrics[phase] = this.signal[phase] = 0;
    }
    this.outputIndex++;
  }
}

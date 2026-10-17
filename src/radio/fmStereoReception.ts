/** Recent reception summary; deliberately separate from instantaneous audio mode. */
export type FmStereoReception = "stereo" | "mono" | "intermittent";

const BIN_SECONDS = 0.05;
const WINDOW_BINS = 20;
const EVALUATION_BINS = 5;

/** Fixed one-second window, evaluated at 4 Hz in acquisition sample time.
 * Stereo needs one second of consistent evidence; mono/intermittent need two.
 * Audio remains free to fall back immediately, independently of this summary. */
export class FmStereoReceptionTracker {
  private readonly lockedBins = new Float64Array(WINDOW_BINS);
  private cursor = 0;
  private filled = 0;
  private evaluationBins = 0;
  private binSeconds = 0;
  private binLockedSeconds = 0;
  private lockedSeconds = 0;
  private candidate?: FmStereoReception;
  private candidateSeconds = 0;
  private unsettledSeconds = 0;
  private reception?: FmStereoReception;

  reset(): void {
    this.lockedBins.fill(0);
    this.cursor = this.filled = this.evaluationBins = 0;
    this.binSeconds = this.binLockedSeconds = this.lockedSeconds = 0;
    this.candidate = this.reception = undefined;
    this.candidateSeconds = this.unsettledSeconds = 0;
  }

  receive(locked: boolean, seconds: number): FmStereoReception | undefined {
    while (seconds > 1e-12) {
      const duration = Math.min(seconds, BIN_SECONDS - this.binSeconds);
      this.binSeconds += duration;
      if (locked) this.binLockedSeconds += duration;
      seconds -= duration;
      if (this.binSeconds < BIN_SECONDS - 1e-12) break;
      this.lockedSeconds +=
        this.binLockedSeconds - this.lockedBins[this.cursor]!;
      this.lockedBins[this.cursor] = this.binLockedSeconds;
      this.cursor = (this.cursor + 1) % WINDOW_BINS;
      this.filled = Math.min(WINDOW_BINS, this.filled + 1);
      this.binSeconds = this.binLockedSeconds = 0;
      if (++this.evaluationBins !== EVALUATION_BINS) continue;
      this.evaluationBins = 0;
      const fraction = this.lockedSeconds / (this.filled * BIN_SECONDS);
      const candidate: FmStereoReception =
        fraction >= 0.9 - 1e-9
          ? "stereo"
          : fraction <= 0.1 + 1e-9
            ? "mono"
            : "intermittent";
      this.candidateSeconds =
        candidate === this.candidate
          ? this.candidateSeconds + BIN_SECONDS * EVALUATION_BINS
          : BIN_SECONDS * EVALUATION_BINS;
      this.candidate = candidate;
      this.unsettledSeconds =
        candidate === this.reception
          ? 0
          : this.unsettledSeconds + BIN_SECONDS * EVALUATION_BINS;
      if (
        this.filled === WINDOW_BINS &&
        this.candidateSeconds >= (candidate === "stereo" ? 1 : 2)
      )
        this.reception = candidate;
      else if (
        this.filled === WINDOW_BINS &&
        candidate === "intermittent" &&
        this.unsettledSeconds >= 2
      )
        // Classification near a threshold may keep changing its candidate.
        // Prolonged uncertainty must not retain a stale stereo/checking label.
        this.reception = "intermittent";
    }
    return this.reception;
  }
}

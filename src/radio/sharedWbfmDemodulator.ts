import {
  FmStereoReceptionTracker,
  type FmStereoReception,
} from "./fmStereoReception";
import {
  DemodWBFMStage1,
  DemodWBFMStage2,
  type ModeWBFM,
} from "@jtarrio/signals/demod/demod-wbfm.js";
import { DemodCW, type ModeCW } from "@jtarrio/signals/demod/demod-cw.js";
import {
  getDemod,
  modeParameters,
  type Demod,
  type Mode,
} from "@jtarrio/signals/demod/modes.js";
import type { Player } from "@jtarrio/signals/demod/player.js";
import type { SampleBlock } from "@jtarrio/signals/radio/sample_block.js";
import type { SquelchMeterState } from "./types";

const SQUELCH_TAIL_SECONDS = 0.1;
const SQUELCH_HYSTERESIS = 0.1;
// Average short-block power estimates in sample time. A single noisy 3 ms USB
// block must not open a 100 ms audio tail while the displayed meter stays low.
const SQUELCH_LEVEL_SECONDS = 0.025;
const METER_INTERVAL_MS = 200;
const PEAK_HOLD_MS = 1_500;

/** Uses public Signals stages, with one untouched multiplex tap before stereo
 * extraction. Other modes retain the existing Signals demodulator/squelch path. */
export class SharedWbfmDemodulator {
  readonly sharesWbfmMultiplex = true;
  private other?: Demod<Mode>;
  private otherMode?: Mode;
  private rate = 1_024_000;
  private offset = 0;
  private mode: ModeWBFM | undefined = { scheme: "WBFM", stereo: true };
  private cwMode?: ModeCW;
  private cw?: DemodCW;
  private cwToneFrequency = 600;
  private first!: DemodWBFMStage1;
  private second!: DemodWBFMStage2;
  private expected?: { center: number; offset: number };
  private squelchOpen = true;
  private squelchTail = 0;
  private smoothedLevel = 0;
  private peakLevel = 0;
  private peakAt = 0;
  private meterAt = 0;
  private reportedSquelchOpen?: boolean;
  private readonly stereoReception = new FmStereoReceptionTracker();
  private reportedStereo?: FmStereoReception;
  private stereoReportedAt = 0;
  constructor(
    private readonly player: Player,
    private readonly multiplex: (samples: Float32Array) => void,
    private readonly reportSquelch?: (state: SquelchMeterState) => void,
    private readonly reportStereo?: (
      stereo: FmStereoReception | undefined,
    ) => void,
  ) {
    this.reset();
  }
  private reset(): void {
    this.resetStereoReception();
    if (this.mode) {
      const intermediate = Math.min(this.rate, 336_000);
      this.first = new DemodWBFMStage1(this.rate, intermediate, this.mode);
      this.second = new DemodWBFMStage2(
        intermediate,
        this.player.sampleRate,
        this.mode,
      );
    }
    if (this.cwMode)
      this.cw = new DemodCW(this.rate, this.player.sampleRate, this.cwMode, {
        toneFrequency: this.cwToneFrequency,
      });
    if (this.otherMode)
      this.other = getDemod(this.rate, this.player.sampleRate, this.otherMode);
    this.resetSquelch();
  }

  private resetStereoReception(): void {
    this.stereoReception.reset();
    this.reportedStereo = undefined;
    this.stereoReportedAt = 0;
    this.reportStereo?.(undefined);
  }

  private resetSquelch(): void {
    this.squelchOpen =
      !this.otherMode || modeParameters(this.otherMode).getSquelch() === 0;
    this.squelchTail = 0;
    this.smoothedLevel = 0;
    this.peakLevel = 0;
    this.peakAt = 0;
    this.meterAt = 0;
    this.reportedSquelchOpen = undefined;
  }
  setMode(mode: Mode): void {
    if (mode.scheme === "WBFM") {
      this.mode = mode as ModeWBFM;
      this.cwMode = undefined;
      this.cw = undefined;
      this.reset();
    } else if (mode.scheme === "CW") {
      this.mode = undefined;
      this.cwMode = mode as ModeCW;
      this.reset();
    } else {
      this.resetStereoReception();
      this.mode = undefined;
      this.cwMode = undefined;
      this.cw = undefined;
      if (this.otherMode?.scheme === mode.scheme && this.other)
        this.other.setMode(mode);
      else this.other = getDemod(this.rate, this.player.sampleRate, mode);
      this.otherMode = mode;
      this.resetSquelch();
    }
  }
  setCwToneFrequency(frequencyHz: number): void {
    this.cwToneFrequency = frequencyHz;
    if (this.cwMode) this.reset();
  }
  setSampleRate(rate: number): void {
    this.rate = rate;
    this.reset();
  }
  setFrequencyOffset(offset: number): void {
    this.offset = offset;
    this.reset();
  }
  expectFrequencyAndSetOffset(center: number, offset: number): void {
    this.expected = { center, offset };
  }
  setVolume(volume: number): void {
    this.player.setVolume(volume);
  }
  receiveSamples(block: SampleBlock): void {
    if (this.expected?.center === block.frequency) {
      this.setFrequencyOffset(this.expected.offset);
      this.expected = undefined;
    }
    if (this.cw) {
      const audio = this.cw.demodulate(block.I, block.Q, this.offset);
      this.player.play(audio.left, audio.right);
      return;
    }
    if (!this.mode) {
      if (!this.other || !this.otherMode) return;
      const audio = this.other.demodulate(block.I, block.Q, this.offset);
      this.applySquelch(audio.left, audio.right, audio.snr);
      this.player.play(audio.left, audio.right);
      return;
    }
    const raw = this.first.demodulate(block.I, block.Q, this.offset);
    this.multiplex(raw.left);
    const audio = this.second.demodulate(raw.left);
    const reception = this.stereoReception.receive(
      audio.stereo,
      block.I.length / this.rate,
    );
    const now = performance.now();
    if (
      reception !== this.reportedStereo ||
      now - this.stereoReportedAt >= 1000
    ) {
      this.stereoReportedAt = now;
      this.reportedStereo = reception;
      this.reportStereo?.(reception);
    }
    this.player.play(audio.left, audio.right);
  }

  private applySquelch(
    left: Float32Array,
    right: Float32Array,
    level: number,
  ): void {
    const threshold = modeParameters(this.otherMode!).getSquelch();
    const finiteLevel = Number.isFinite(level) ? Math.max(0, level) : 0;
    const alpha = -Math.expm1(
      -left.length / (this.player.sampleRate * SQUELCH_LEVEL_SECONDS),
    );
    this.smoothedLevel += alpha * (finiteLevel - this.smoothedLevel);
    if (threshold === 0) {
      this.squelchOpen = true;
      this.squelchTail = 0;
    } else {
      const boundary = this.squelchOpen
        ? Math.max(0, threshold - SQUELCH_HYSTERESIS)
        : threshold + SQUELCH_HYSTERESIS;
      if (this.smoothedLevel > boundary) {
        this.squelchOpen = true;
        this.squelchTail = SQUELCH_TAIL_SECONDS * this.player.sampleRate;
      } else if (this.squelchTail > 0) {
        this.squelchTail -= left.length;
      } else {
        this.squelchOpen = false;
        left.fill(0);
        right.fill(0);
      }
    }
    this.updateMeter();
  }

  private updateMeter(): void {
    const now = performance.now();
    if (
      this.smoothedLevel >= this.peakLevel ||
      now - this.peakAt >= PEAK_HOLD_MS
    ) {
      this.peakLevel = this.smoothedLevel;
      this.peakAt = now;
    }
    if (!this.reportSquelch) return;
    const openChanged = this.reportedSquelchOpen !== this.squelchOpen;
    if (!openChanged && now - this.meterAt < METER_INTERVAL_MS) return;
    this.meterAt = now;
    this.reportedSquelchOpen = this.squelchOpen;
    this.reportSquelch({
      level: Math.min(6, this.smoothedLevel),
      peak: Math.min(6, this.peakLevel),
      open: this.squelchOpen,
    });
  }
}

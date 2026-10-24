import { SharedWbfmDemodulator } from "./sharedWbfmDemodulator";
import { PcmBatchPlayer } from "./pcmBatchPlayer";
import {
  createSignalsMode,
  normalizeModeSettings,
  planChannelTune,
} from "./receiverConfig";
import {
  WidebandChannelWorker,
  type ChannelWorkerPort,
} from "./widebandChannel";
import { channelSampleRate, isWidebandRate } from "./sourceCapabilities";
import type { Player } from "@jtarrio/signals/demod/player.js";
import type { SampleBlock } from "@jtarrio/signals/radio/sample_block.js";
import type { SourceSessionMetadata } from "./types";

export interface SecondaryVfoSettings {
  frequencyHz: number;
  mode: "AM" | "NBFM" | "USB" | "LSB" | "CW";
  bandwidthHz: number;
  squelch: number;
  volume: number;
  muted: boolean;
  recordAudio: boolean;
}
export function validateSecondaryVfo(
  value: SecondaryVfoSettings,
  session: SourceSessionMetadata,
): SecondaryVfoSettings {
  if (
    !["AM", "NBFM", "USB", "LSB", "CW"].includes(value.mode) ||
    !Number.isFinite(value.volume) ||
    value.volume < 0 ||
    value.volume > 1 ||
    typeof value.muted !== "boolean" ||
    typeof value.recordAudio !== "boolean"
  )
    throw new Error("Invalid second VFO settings.");
  const mode = normalizeModeSettings({
    mode: value.mode,
    bandwidthHz: value.bandwidthHz,
    squelch: value.squelch,
  });
  if (
    planChannelTune(
      session.hardwareCenterFrequencyHz,
      value.frequencyHz,
      session.actualSampleRateHz,
      mode.bandwidthHz,
    ).hardwareRetuneRequired
  )
    throw new Error(
      "VFO B must fit inside the current RF capture; it cannot retune the shared receiver.",
    );
  return { ...value, bandwidthHz: mode.bandwidthHz, squelch: mode.squelch };
}

/** Each channel uses the existing AudioContext. Bound and cancel actual WebAudio
 * nodes so a stalled optional channel can never grow the primary audio queue. */
class VfoPlayer implements Player {
  readonly sampleRate = 48_000;
  private volume = 0;
  private next = 0;
  private readonly nodes = new Set<AudioBufferSourceNode>();
  private readonly gain: GainNode;
  constructor(private readonly context: AudioContext) {
    this.gain = context.createGain();
    this.gain.connect(context.destination);
  }
  getVolume() {
    return this.volume;
  }
  setVolume(value: number) {
    this.volume = value;
    this.gain.gain.value = value;
  }
  play(left: Float32Array, right: Float32Array) {
    const now = this.context.currentTime;
    if (this.next - now > 0.5 || this.nodes.size >= 32) this.reset();
    const buffer = this.context.createBuffer(2, left.length, this.sampleRate);
    buffer.copyToChannel(new Float32Array(left), 0);
    buffer.copyToChannel(new Float32Array(right), 1);
    const node = this.context.createBufferSource();
    node.buffer = buffer;
    node.connect(this.gain);
    this.nodes.add(node);
    node.onended = () => {
      this.nodes.delete(node);
      node.disconnect();
    };
    this.next = Math.max(this.next, now + 0.025);
    node.start(this.next);
    this.next += left.length / this.sampleRate;
  }
  reset() {
    for (const node of this.nodes) {
      node.onended = null;
      try {
        node.stop();
      } catch {
        /* Already ended. */
      }
      node.disconnect();
    }
    this.nodes.clear();
    this.next = 0;
  }
  close() {
    this.reset();
    this.gain.disconnect();
  }
}

export class SecondaryVfo {
  settings?: SecondaryVfoSettings;
  private session?: SourceSessionMetadata;
  private channel?: WidebandChannelWorker;
  private readonly output: VfoPlayer;
  private readonly player: PcmBatchPlayer;
  private readonly demod: SharedWbfmDemodulator;
  private scratchI = new Float32Array(0);
  private scratchQ = new Float32Array(0);
  private epoch = 0;
  private closed = false;
  constructor(
    context: AudioContext,
    private readonly changed: (
      settings: SecondaryVfoSettings | undefined,
      message?: string,
    ) => void,
    private readonly workerFactory?: () => ChannelWorkerPort,
  ) {
    this.output = new VfoPlayer(context);
    this.player = new PcmBatchPlayer(
      this.output,
      () =>
        `VFO B ${this.settings?.mode}; ${this.settings?.frequencyHz} Hz; generation ${this.session?.sessionGeneration}. Processed audio.`,
      context,
      () => this.settings?.recordAudio === true,
      () => false,
    );
    this.demod = new SharedWbfmDemodulator(this.player, () => undefined);
  }
  async configure(
    settings: SecondaryVfoSettings,
    session: SourceSessionMetadata,
  ) {
    const value = validateSecondaryVfo(settings, session),
      epoch = ++this.epoch;
    this.clear();
    this.session = structuredClone(session);
    this.demod.setSampleRate(channelSampleRate(session.actualSampleRateHz));
    this.demod.setMode(
      createSignalsMode({
        mode: value.mode,
        bandwidthHz: value.bandwidthHz,
        squelch: value.squelch,
      }),
    );
    this.demod.setFrequencyOffset(
      isWidebandRate(session.actualSampleRateHz)
        ? 0
        : value.frequencyHz - session.hardwareCenterFrequencyHz,
    );
    this.demod.setVolume(value.muted ? 0 : value.volume);
    this.player.configure(true);
    if (isWidebandRate(session.actualSampleRateHz)) {
      const channel = new WidebandChannelWorker(
        (block) => {
          if (this.settings && this.epoch === epoch)
            this.demod.receiveSamples(block);
        },
        (error) => {
          if (this.epoch === epoch) this.stop(error.message);
        },
        this.workerFactory,
      );
      this.channel = channel;
      try {
        await channel.configure(
          session.sessionGeneration,
          value.frequencyHz - session.hardwareCenterFrequencyHz,
          session.actualSampleRateHz,
          session.source === "hackrf"
            ? "ci8"
            : session.source === "bladerf"
              ? "sc16"
              : session.source === "usrp-b205"
                ? "usrp-sc16"
                : false,
        );
      } catch (error) {
        if (this.epoch === epoch) this.stop(String(error));
        throw error;
      }
    }
    if (this.epoch !== epoch || this.closed) return;
    this.settings = value;
    this.changed({ ...value });
  }
  retune(session: SourceSessionMetadata) {
    if (!this.settings) return;
    const settings = this.settings;
    // A new captured context invalidates pending worker replies immediately.
    const task = this.configure(settings, session),
      epoch = this.epoch;
    void task.catch((error) => {
      if (this.epoch === epoch) this.stop(String(error));
    });
  }
  receive(block: SampleBlock) {
    if (
      !this.settings ||
      block.frequency !== this.session?.hardwareCenterFrequencyHz
    )
      return;
    try {
      if (this.channel) {
        this.channel.receive(block, this.settings.frequencyHz);
        return;
      }
      if (block.I.length > 262_144)
        throw new Error("VFO B input exceeds its bounded block size.");
      if (this.scratchI.length < block.I.length) {
        this.scratchI = new Float32Array(block.I.length);
        this.scratchQ = new Float32Array(block.I.length);
      }
      const I = this.scratchI.subarray(0, block.I.length),
        Q = this.scratchQ.subarray(0, block.Q.length);
      I.set(block.I);
      Q.set(block.Q);
      this.demod.receiveSamples({ ...block, I, Q });
    } catch (error) {
      this.stop(`VFO B stopped: ${String(error)}`);
    }
  }
  native(
    bytes: Uint8Array,
    frequency: number,
    kind: "ci8" | "sc16" | "usrp-sc16",
  ) {
    if (
      !this.settings ||
      !this.channel ||
      frequency !== this.session?.hardwareCenterFrequencyHz
    )
      return;
    try {
      if (kind === "ci8")
        this.channel.receiveCi8(bytes, this.settings.frequencyHz);
      else if (kind === "sc16")
        this.channel.receiveSc16(bytes, this.settings.frequencyHz);
      else this.channel.receiveUsrpSc16(bytes, this.settings.frequencyHz);
    } catch (error) {
      this.stop(`VFO B stopped: ${String(error)}`);
    }
  }
  private clear() {
    this.settings = undefined;
    this.channel?.close();
    this.channel = undefined;
    this.player.reset();
    this.output.reset();
  }
  stop(message?: string) {
    ++this.epoch;
    this.clear();
    this.changed(undefined, message);
  }
  close() {
    this.closed = true;
    this.stop();
    this.output.close();
  }
}

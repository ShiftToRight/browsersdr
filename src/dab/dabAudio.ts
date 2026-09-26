import type { Player } from "@jtarrio/signals/demod/player.js";
import {
  getRealResampler,
  type RealResampler,
} from "@jtarrio/signals/dsp/resamplers.js";

export interface DabPlusAudioFormat {
  dacRate: boolean;
  sbr: boolean;
  stereo: boolean;
  parametricStereo: boolean;
  mpegSurround: number;
}

export interface DabPcmSink {
  (left: Float32Array, right: Float32Array, sampleRateHz: number): void;
}

/** Cancellable, bounded playback queue so a station switch stops old audio. */
export class DabAudioPlayer implements Player {
  readonly sampleRate = 48_000;
  private readonly sources = new Set<AudioBufferSourceNode>();
  private gain?: GainNode;
  private volume = 0;
  private nextTime = 0;
  constructor(private readonly context: AudioContext) {}
  getVolume(): number {
    return this.volume;
  }
  setVolume(volume: number): void {
    this.volume = volume;
    if (this.gain) this.gain.gain.value = volume;
  }
  play(left: Float32Array, right: Float32Array): void {
    if (!left.length || left.length !== right.length) return;
    if (!this.gain) {
      this.gain = this.context.createGain();
      this.gain.gain.value = this.volume;
      this.gain.connect(this.context.destination);
    }
    const now = this.context.currentTime;
    // Decoder/USB bursts may enqueue several frames together; never grow
    // latency without bound after a stalled or backgrounded tab.
    if (this.nextTime - now > 1) this.reset();
    const buffer = this.context.createBuffer(2, left.length, this.sampleRate);
    buffer.copyToChannel(Float32Array.from(left), 0);
    buffer.copyToChannel(Float32Array.from(right), 1);
    const source = this.context.createBufferSource();
    source.buffer = buffer;
    source.connect(this.gain);
    source.onended = () => {
      this.sources.delete(source);
      source.disconnect();
    };
    this.sources.add(source);
    const start = Math.max(this.nextTime, now + 0.05);
    source.start(start);
    this.nextTime = start + left.length / this.sampleRate;
  }
  dispose(): void {
    this.reset();
    this.gain?.disconnect();
    this.gain = undefined;
  }
  reset(): void {
    for (const source of this.sources) {
      source.stop();
      source.disconnect();
    }
    this.sources.clear();
    this.nextTime = 0;
  }
}

/** Converts the two DAB+ output rates to the application's 48 kHz Player
 * contract while retaining resampler history between access units. */
export class DabPcmPlayer {
  private inputRateHz?: number;
  private outputRateHz?: number;
  private leftResampler?: RealResampler;
  private rightResampler?: RealResampler;
  constructor(private readonly player: Player) {}
  play(left: Float32Array, right: Float32Array, sampleRateHz: number): void {
    const outputRateHz = this.player.sampleRate;
    if (sampleRateHz === outputRateHz) {
      this.player.play(left, right);
      return;
    }
    if (
      sampleRateHz !== this.inputRateHz ||
      outputRateHz !== this.outputRateHz
    ) {
      this.leftResampler = getRealResampler(sampleRateHz, outputRateHz);
      this.rightResampler = this.leftResampler.clone();
      this.inputRateHz = sampleRateHz;
      this.outputRateHz = outputRateHz;
    }
    this.player.play(
      this.leftResampler!.resample(left),
      this.rightResampler!.resample(right),
    );
  }
  reset(): void {
    this.inputRateHz = undefined;
    this.outputRateHz = undefined;
    this.leftResampler = undefined;
    this.rightResampler = undefined;
  }
}

export interface DabAudioDecoderStatus {
  state: "unavailable" | "checking" | "ready" | "error" | "closed";
  codec?: string;
  message: string;
}

interface DecoderAudioData {
  readonly numberOfChannels: number;
  readonly numberOfFrames: number;
  readonly sampleRate: number;
  copyTo(
    destination: AllowSharedBufferSource,
    options: AudioDataCopyToOptions,
  ): void;
  close(): void;
}

interface DecoderInstance {
  readonly state: CodecState;
  configure(config: AudioDecoderConfig): void;
  decode(chunk: EncodedAudioChunk): void;
  flush(): Promise<void>;
  reset(): void;
  close(): void;
}

export interface DabWebCodecsBindings {
  available(): boolean;
  isConfigSupported(config: AudioDecoderConfig): Promise<AudioDecoderSupport>;
  createDecoder(init: {
    output(data: DecoderAudioData): void;
    error(error: DOMException): void;
  }): DecoderInstance;
  createChunk(init: EncodedAudioChunkInit): EncodedAudioChunk;
}

class BitWriter {
  private readonly bits: number[] = [];
  write(value: number, count: number): void {
    for (let shift = count - 1; shift >= 0; shift -= 1)
      this.bits.push((value >> shift) & 1);
  }
  bytes(): Uint8Array {
    const output = new Uint8Array(Math.ceil(this.bits.length / 8));
    for (let index = 0; index < this.bits.length; index += 1) {
      const byte = index >> 3;
      output[byte] = output[byte]! | (this.bits[index]! << (7 - (index & 7)));
    }
    return output;
  }
}

const SAMPLE_RATE_INDEX = new Map([
  [16_000, 8],
  [24_000, 6],
  [32_000, 5],
  [48_000, 3],
]);

export function dabPlusOutputSampleRate(format: DabPlusAudioFormat): number {
  return format.dacRate ? 48_000 : 32_000;
}
export function dabPlusCoreSampleRate(format: DabPlusAudioFormat): number {
  const output = dabPlusOutputSampleRate(format);
  return format.sbr ? output / 2 : output;
}
export function dabPlusOutputChannels(format: DabPlusAudioFormat): number {
  return format.stereo || format.parametricStereo ? 2 : 1;
}
export function dabPlusAccessUnitDurationUs(
  format: DabPlusAudioFormat,
): number {
  return Math.round(960_000_000 / dabPlusCoreSampleRate(format));
}
export function dabPlusCodec(format: DabPlusAudioFormat): string {
  return format.parametricStereo
    ? "mp4a.40.29"
    : format.sbr
      ? "mp4a.40.5"
      : "mp4a.40.2";
}

/** MPEG-4 AudioSpecificConfig for the DAB+ 960-sample transform.
 * AAC-LC is signalled first for backwards compatibility, followed by the
 * standard SBR/PS sync extensions when those tools are active. */
export function createDabPlusAudioSpecificConfig(
  format: DabPlusAudioFormat,
): Uint8Array {
  if (format.parametricStereo && (!format.sbr || format.stereo)) {
    throw new Error("DAB+ parametric stereo requires an SBR mono AAC core.");
  }
  if (format.mpegSurround !== 0)
    throw new Error("DAB+ MPEG Surround output is not supported yet.");
  const coreRate = dabPlusCoreSampleRate(format);
  const outputRate = dabPlusOutputSampleRate(format);
  const coreRateIndex = SAMPLE_RATE_INDEX.get(coreRate);
  const outputRateIndex = SAMPLE_RATE_INDEX.get(outputRate);
  if (coreRateIndex === undefined || outputRateIndex === undefined)
    throw new Error("Unsupported DAB+ sample rate.");

  const bits = new BitWriter();
  bits.write(2, 5); // AAC-LC AudioObjectType
  bits.write(coreRateIndex, 4);
  bits.write(format.stereo ? 2 : 1, 4);
  bits.write(1, 1); // frameLengthFlag: 960 rather than 1024 samples
  bits.write(0, 1); // dependsOnCoreCoder
  bits.write(0, 1); // extensionFlag
  if (format.sbr) {
    bits.write(0x2b7, 11); // syncExtensionType
    bits.write(5, 5); // SBR AudioObjectType
    bits.write(1, 1); // sbrPresentFlag
    bits.write(outputRateIndex, 4);
    if (format.parametricStereo) {
      bits.write(0x548, 11); // PS syncExtensionType
      bits.write(1, 1); // psPresentFlag
    }
  }
  return bits.bytes();
}

export function createDabPlusAudioDecoderConfig(
  format: DabPlusAudioFormat,
): AudioDecoderConfig {
  return {
    codec: dabPlusCodec(format),
    sampleRate: dabPlusOutputSampleRate(format),
    numberOfChannels: dabPlusOutputChannels(format),
    description: createDabPlusAudioSpecificConfig(format),
  };
}

function browserBindings(): DabWebCodecsBindings {
  return {
    available: () =>
      typeof AudioDecoder !== "undefined" &&
      typeof EncodedAudioChunk !== "undefined" &&
      globalThis.isSecureContext,
    isConfigSupported: (config) => AudioDecoder.isConfigSupported(config),
    createDecoder: (init) => new AudioDecoder(init),
    createChunk: (init) => new EncodedAudioChunk(init),
  };
}

const PROBE_FORMATS: readonly DabPlusAudioFormat[] = [
  {
    dacRate: true,
    sbr: false,
    stereo: true,
    parametricStereo: false,
    mpegSurround: 0,
  },
  {
    dacRate: true,
    sbr: true,
    stereo: true,
    parametricStereo: false,
    mpegSurround: 0,
  },
  {
    dacRate: true,
    sbr: true,
    stereo: false,
    parametricStereo: true,
    mpegSurround: 0,
  },
];

export async function probeDabPlusAudioSupport(
  bindings: DabWebCodecsBindings = browserBindings(),
): Promise<boolean> {
  if (!bindings.available()) return false;
  const results = await Promise.all(
    PROBE_FORMATS.map((format) =>
      bindings.isConfigSupported(createDabPlusAudioDecoderConfig(format)),
    ),
  );
  return results.every((result) => result.supported === true);
}

/** Thin, replaceable bridge to the browser/OS AAC implementation. It owns no
 * AAC implementation and accepts only CRC-validated raw DAB+ access units. */
export class WebCodecsDabAudioDecoder {
  private decoder?: DecoderInstance;
  private generation = 0;
  private configured?: DabPlusAudioFormat;
  private timestampUs = 0;
  private status: DabAudioDecoderStatus = {
    state: "unavailable",
    message: "DAB+ audio decoder has not been checked.",
  };

  constructor(
    private readonly output: DabPcmSink,
    private readonly onStatus: (status: DabAudioDecoderStatus) => void = () =>
      undefined,
    private readonly bindings: DabWebCodecsBindings = browserBindings(),
  ) {}

  get current(): DabAudioDecoderStatus {
    return this.status;
  }

  async configure(format: DabPlusAudioFormat): Promise<void> {
    const generation = ++this.generation;
    if (!this.bindings.available()) {
      this.publish({
        state: "unavailable",
        message:
          "WebCodecs AAC decoding requires a secure, compatible browser.",
      });
      throw new DOMException(this.status.message, "NotSupportedError");
    }
    const config = createDabPlusAudioDecoderConfig(format);
    this.publish({
      state: "checking",
      codec: config.codec,
      message: `Checking browser support for ${config.codec}…`,
    });
    const support = await this.bindings.isConfigSupported(config);
    if (generation !== this.generation)
      throw new DOMException(
        "DAB audio configuration was cancelled.",
        "AbortError",
      );
    if (!support.supported) {
      this.publish({
        state: "unavailable",
        codec: config.codec,
        message: `This browser cannot decode the DAB+ ${config.codec} configuration.`,
      });
      throw new DOMException(this.status.message, "NotSupportedError");
    }
    if (!this.decoder || this.decoder.state === "closed") {
      this.decoder = this.bindings.createDecoder({
        output: (data) => this.handleOutput(data),
        error: (error) => this.handleError(error),
      });
    } else if (this.decoder.state === "configured") {
      this.decoder.reset();
    }
    this.decoder.configure(config);
    this.configured = { ...format };
    this.timestampUs = 0;
    this.publish({
      state: "ready",
      codec: config.codec,
      message: `Browser ${config.codec} decoder ready.`,
    });
  }

  decode(accessUnit: Uint8Array): void {
    if (
      !this.decoder ||
      this.decoder.state !== "configured" ||
      !this.configured
    ) {
      throw new DOMException(
        "Configure the DAB+ audio decoder before supplying access units.",
        "InvalidStateError",
      );
    }
    const duration = dabPlusAccessUnitDurationUs(this.configured);
    this.decoder.decode(
      this.bindings.createChunk({
        type: "key",
        timestamp: this.timestampUs,
        duration,
        data: accessUnit,
      }),
    );
    this.timestampUs += duration;
  }

  async flush(): Promise<void> {
    await this.decoder?.flush();
  }
  reset(): void {
    this.generation += 1;
    if (this.decoder && this.decoder.state !== "closed") this.decoder.reset();
    this.configured = undefined;
    this.timestampUs = 0;
  }
  close(): void {
    this.generation += 1;
    if (this.decoder && this.decoder.state !== "closed") this.decoder.close();
    this.decoder = undefined;
    this.configured = undefined;
    this.publish({ state: "closed", message: "DAB+ audio decoder closed." });
  }

  private handleOutput(data: DecoderAudioData): void {
    try {
      const left = new Float32Array(data.numberOfFrames);
      data.copyTo(left, { planeIndex: 0, format: "f32-planar" });
      const right =
        data.numberOfChannels > 1
          ? new Float32Array(data.numberOfFrames)
          : left;
      if (data.numberOfChannels > 1)
        data.copyTo(right, { planeIndex: 1, format: "f32-planar" });
      this.output(left, right, data.sampleRate);
    } finally {
      data.close();
    }
  }

  private handleError(error: DOMException): void {
    this.publish({
      state: "error",
      codec: this.status.codec,
      message: `Browser AAC decoder failed: ${error.message}`,
    });
  }
  private publish(status: DabAudioDecoderStatus): void {
    this.status = status;
    this.onStatus(status);
  }
}

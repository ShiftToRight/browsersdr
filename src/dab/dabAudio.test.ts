import { describe, expect, it, vi } from "vitest";
import {
  WebCodecsDabAudioDecoder,
  createDabPlusAudioDecoderConfig,
  createDabPlusAudioSpecificConfig,
  dabPlusAccessUnitDurationUs,
  probeDabPlusAudioSupport,
  type DabPlusAudioFormat,
  type DabWebCodecsBindings,
} from "./dabAudio";

const LC_STEREO: DabPlusAudioFormat = {
  dacRate: true,
  sbr: false,
  stereo: true,
  parametricStereo: false,
  mpegSurround: 0,
};
const HE_PS: DabPlusAudioFormat = {
  dacRate: true,
  sbr: true,
  stereo: false,
  parametricStereo: true,
  mpegSurround: 0,
};

function fakeBindings() {
  const configs: AudioDecoderConfig[] = [],
    chunks: EncodedAudioChunkInit[] = [];
  let decoderState: CodecState = "unconfigured";
  let output:
    Parameters<DabWebCodecsBindings["createDecoder"]>[0]["output"] | undefined;
  const bindings: DabWebCodecsBindings = {
    available: () => true,
    isConfigSupported: async (config) => ({ supported: true, config }),
    createDecoder: (init) => {
      output = init.output;
      return {
        get state() {
          return decoderState;
        },
        configure(config) {
          configs.push(config);
          decoderState = "configured";
        },
        decode: vi.fn(),
        flush: async () => undefined,
        reset() {
          decoderState = "unconfigured";
        },
        close() {
          decoderState = "closed";
        },
      };
    },
    createChunk: (init) => {
      chunks.push(init);
      return { ...init } as unknown as EncodedAudioChunk;
    },
  };
  return {
    bindings,
    configs,
    chunks,
    emit: (data: Parameters<NonNullable<typeof output>>[0]) => output?.(data),
  };
}

describe("DAB+ browser audio", () => {
  it("builds a 960-sample AAC-LC AudioSpecificConfig", () => {
    expect([...createDabPlusAudioSpecificConfig(LC_STEREO)]).toEqual([
      0x11, 0x94,
    ]);
    expect(createDabPlusAudioDecoderConfig(HE_PS).codec).toBe("mp4a.40.29");
    expect(dabPlusAccessUnitDurationUs(HE_PS)).toBe(40_000);
  });

  it("rejects invalid parametric-stereo signalling", () => {
    expect(() =>
      createDabPlusAudioSpecificConfig({ ...HE_PS, sbr: false }),
    ).toThrow(/requires an SBR mono/);
    expect(() =>
      createDabPlusAudioSpecificConfig({ ...HE_PS, stereo: true }),
    ).toThrow(/requires an SBR mono/);
  });

  it("probes LC, HE-AAC and HE-AAC v2", async () => {
    const codecs: string[] = [];
    const bindings = fakeBindings().bindings;
    bindings.isConfigSupported = async (config) => {
      codecs.push(config.codec);
      return { supported: true, config };
    };
    await expect(probeDabPlusAudioSupport(bindings)).resolves.toBe(true);
    expect(codecs).toEqual(["mp4a.40.2", "mp4a.40.5", "mp4a.40.29"]);
  });

  it("configures WebCodecs, timestamps AUs and forwards planar PCM", async () => {
    const fake = fakeBindings(),
      pcm = vi.fn(),
      status = vi.fn();
    const decoder = new WebCodecsDabAudioDecoder(pcm, status, fake.bindings);
    await decoder.configure(HE_PS);
    decoder.decode(Uint8Array.of(1, 2, 3));
    decoder.decode(Uint8Array.of(4, 5));
    expect(fake.configs[0]?.codec).toBe("mp4a.40.29");
    expect(
      fake.chunks.map((chunk) => [chunk.timestamp, chunk.duration]),
    ).toEqual([
      [0, 40_000],
      [40_000, 40_000],
    ]);

    const close = vi.fn();
    fake.emit({
      numberOfChannels: 1,
      numberOfFrames: 3,
      sampleRate: 48_000,
      copyTo(destination) {
        new Float32Array((destination as ArrayBufferView).buffer).set([
          0.25, -0.5, 1,
        ]);
      },
      close,
    });
    expect(pcm).toHaveBeenCalledWith(
      expect.objectContaining({ length: 3 }),
      expect.objectContaining({ length: 3 }),
      48_000,
    );
    expect(pcm.mock.calls[0]?.[0]).toBe(pcm.mock.calls[0]?.[1]);
    expect(close).toHaveBeenCalledOnce();
    expect(status).toHaveBeenLastCalledWith(
      expect.objectContaining({ state: "ready" }),
    );
  });
  it("does not resurrect an audio decoder after an asynchronous probe is cancelled", async () => {
    const fake = fakeBindings();
    let resolve!: (support: AudioDecoderSupport) => void;
    fake.bindings.isConfigSupported = (config) =>
      new Promise((done) => {
        resolve = (support) => done({ ...support, config });
      });
    const decoder = new WebCodecsDabAudioDecoder(
      vi.fn(),
      vi.fn(),
      fake.bindings,
    );
    const pending = decoder.configure(HE_PS);
    decoder.close();
    resolve({
      supported: true,
      config: createDabPlusAudioDecoderConfig(HE_PS),
    });
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(fake.configs).toHaveLength(0);
  });
});

it("cancels scheduled station audio and schedules varying block sizes contiguously", async () => {
  const { DabAudioPlayer } = await import("./dabAudio");
  const sources: {
    start: ReturnType<typeof vi.fn>;
    stop: ReturnType<typeof vi.fn>;
    connect: ReturnType<typeof vi.fn>;
    disconnect: ReturnType<typeof vi.fn>;
  }[] = [];
  const context = {
    currentTime: 10,
    destination: {},
    createGain: () => ({ gain: { value: 0 }, connect: vi.fn() }),
    createBuffer: () => ({ copyToChannel: vi.fn() }),
    createBufferSource: () => {
      const source = {
        start: vi.fn(),
        stop: vi.fn(),
        connect: vi.fn(),
        disconnect: vi.fn(),
      };
      sources.push(source);
      return source;
    },
  };
  const player = new DabAudioPlayer(context as unknown as AudioContext);
  player.setVolume(0.6);
  player.play(new Float32Array(960), new Float32Array(960));
  player.play(new Float32Array(1920), new Float32Array(1920));
  expect(sources[0]!.start).toHaveBeenCalledWith(10.05);
  expect(sources[1]!.start.mock.calls[0]![0]).toBeCloseTo(10.07);
  player.reset();
  expect(sources.every((source) => source.stop.mock.calls.length === 1)).toBe(
    true,
  );
  player.play(new Float32Array(960), new Float32Array(960));
  expect(sources[2]!.start).toHaveBeenCalledWith(10.05);
  expect(player.getVolume()).toBe(0.6);
  player.reset();
});

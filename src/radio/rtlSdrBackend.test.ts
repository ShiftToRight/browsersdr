import { afterEach, describe, expect, it, vi } from "vitest";
import type { SignalSource } from "@jtarrio/signals/radio/signal_source.js";
import {
  ReceiverController,
  type ReceiverBackendEvents,
  type ReceiverStartOptions,
} from "./receiverController";
import { RtlSdrBackend, type RtlSdrBackendDependencies } from "./rtlSdrBackend";

const OPTIONS: ReceiverStartOptions = {
  channelFrequencyHz: 100_000_000,
  volume: 0.5,
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function sourceWith(
  close: () => Promise<void>,
  startReceiving: () => Promise<void> = async () => {},
) {
  return {
    setSampleRate: async (rate: number) => rate,
    setCenterFrequency: async (frequency: number) => frequency,
    setParameter: async <V>(_parameter: string, value: V) => value,
    startReceiving,
    readSamples: () => new Promise<never>(() => undefined),
    close,
  } as SignalSource;
}

function audioContextWith(
  close: () => Promise<void>,
  initialState: AudioContextState = "suspended",
) {
  let state = initialState;
  return {
    get state() {
      return state;
    },
    sampleRate: 48_000,
    currentTime: 0,
    destination: {},
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    resume: vi.fn(async () => {
      state = "running";
    }),
    suspend: vi.fn(async () => {
      state = "suspended";
    }),
    close: vi.fn(async () => {
      await close();
      state = "closed";
    }),
  } as unknown as AudioContext;
}

function events(): ReceiverBackendEvents {
  return {
    permissionGranted() {},
    runtimeError() {},
    audioStateChanged() {},
    sourceEnded() {},
    rdsChanged() {},
  };
}

function dependencies(
  source: SignalSource,
  audioContext: AudioContext,
): RtlSdrBackendDependencies {
  return {
    createAudioContext: () => audioContext,
    createSourceProvider: () => ({ get: async () => source }),
  };
}

afterEach(() => vi.unstubAllGlobals());

describe("RtlSdrBackend teardown", () => {
  it("keeps raw spectrum analysis active without feeding the demodulator in OFF mode", async () => {
    vi.stubGlobal("navigator", { usb: {} });
    type Block = import("@jtarrio/signals/radio/sample_block.js").SampleBlock;
    const reads: ReturnType<typeof deferred<Block>>[] = [];
    const source = sourceWith(async () => {});
    source.readSamples = () => {
      const read = deferred<Block>();
      reads.push(read);
      return read.promise;
    };
    const raw: number[] = [];
    const analysis = {
      begin: vi.fn(() => ({
        setSampleRate: vi.fn(),
        receiveSamples: (block: Block) => raw.push(block.I[0]!),
      })),
      stop: vi.fn(),
    };
    const demodulator = {
      setMode: vi.fn(),
      setVolume: vi.fn(),
      setFrequencyOffset: vi.fn(),
      setSampleRate: vi.fn(),
      expectFrequencyAndSetOffset: vi.fn(),
      receiveSamples: vi.fn(),
    };
    const backend = new RtlSdrBackend(
      events(),
      analysis as unknown as import("../dsp/analysisPipeline").AnalysisPipeline,
      1,
      OPTIONS.channelFrequencyHz,
      {
        ...dependencies(source, audioContextWith(async () => {})),
        createDemodulator: () => demodulator,
      },
    );

    await backend.start({
      ...OPTIONS,
      modeSettings: { mode: "OFF", bandwidthHz: 1, squelch: 0 },
    });
    reads.shift()!.resolve({
      I: new Float32Array([0.25]),
      Q: new Float32Array([0.5]),
      frequency: OPTIONS.channelFrequencyHz,
    });
    for (let index = 0; index < 10; index += 1) await Promise.resolve();
    expect(raw).toEqual([0.25]);
    expect(demodulator.setMode).not.toHaveBeenCalled();
    expect(demodulator.receiveSamples).not.toHaveBeenCalled();
    const disconnecting = backend.disconnect();
    for (const read of reads.splice(0))
      read.resolve({
        I: new Float32Array([0]),
        Q: new Float32Array([0]),
        frequency: OPTIONS.channelFrequencyHz,
      });
    await disconnecting;
  });

  it("passes an already-authorized device to the provider without a chooser", async () => {
    vi.stubGlobal("navigator", { usb: {} });
    const granted = { vendorId: 0x0bda, productId: 0x2838 } as USBDevice;
    const createSourceProvider = vi.fn(
      (_permission, _capture, _device?: USBDevice) => ({
        get: async () => sourceWith(async () => {}),
      }),
    );
    const backend = new RtlSdrBackend(
      events(),
      undefined,
      1,
      OPTIONS.channelFrequencyHz,
      {
        createAudioContext: () => audioContextWith(async () => {}),
        createSourceProvider,
      },
    );

    await backend.connectGranted(OPTIONS, granted);

    expect(createSourceProvider).toHaveBeenLastCalledWith(
      expect.any(Function),
      expect.any(Function),
      granted,
    );
    await backend.disconnect();
  });

  it("shares an in-flight source close and retries ownership after a rejection", async () => {
    vi.stubGlobal("navigator", { usb: {} });
    const firstClose = deferred<void>();
    let attempts = 0;
    const close = vi.fn(() =>
      ++attempts === 1 ? firstClose.promise : Promise.resolve(),
    );
    const audioClose = vi.fn(async () => {});
    const backend = new RtlSdrBackend(
      events(),
      undefined,
      1,
      OPTIONS.channelFrequencyHz,
      dependencies(sourceWith(close), audioContextWith(audioClose)),
    );
    await backend.connect(OPTIONS);

    const first = backend.disconnect();
    const concurrent = backend.disconnect();
    await vi.waitFor(() => expect(close).toHaveBeenCalledOnce());
    firstClose.reject(new Error("USB close failed"));
    await expect(first).rejects.toThrow("USB close failed");
    await expect(concurrent).rejects.toThrow("USB close failed");
    expect(audioClose).toHaveBeenCalledOnce();

    await backend.disconnect();
    expect(close).toHaveBeenCalledTimes(2);
    expect(audioClose).toHaveBeenCalledOnce();
  });

  it("attempts audio cleanup independently and retries only the failed audio release", async () => {
    vi.stubGlobal("navigator", { usb: {} });
    const sourceClose = vi.fn(async () => {});
    let audioAttempts = 0;
    const audioClose = vi.fn(async () => {
      if (++audioAttempts === 1) throw new Error("Audio close failed");
    });
    const backend = new RtlSdrBackend(
      events(),
      undefined,
      1,
      OPTIONS.channelFrequencyHz,
      dependencies(sourceWith(sourceClose), audioContextWith(audioClose)),
    );
    await backend.connect(OPTIONS);

    await expect(backend.disconnect()).rejects.toThrow("Audio close failed");
    expect(sourceClose).toHaveBeenCalledOnce();
    await backend.disconnect();
    expect(sourceClose).toHaveBeenCalledOnce();
    expect(audioClose).toHaveBeenCalledTimes(2);
  });

  it("closes a source that arrives after pending startup is cancelled", async () => {
    vi.stubGlobal("navigator", { usb: {} });
    const acquired = deferred<SignalSource>();
    const sourceClose = vi.fn(async () => {});
    const audioClose = vi.fn(async () => {});
    const startReceiving = vi.fn(async () => {});
    const backend = new RtlSdrBackend(
      events(),
      undefined,
      1,
      OPTIONS.channelFrequencyHz,
      {
        createAudioContext: () => audioContextWith(audioClose),
        createSourceProvider: () => ({ get: () => acquired.promise }),
      },
    );

    const starting = backend.start(OPTIONS, 1);
    const startOutcome = starting.then(
      () => "resolved",
      (error: Error) => error.name,
    );
    const disconnecting = backend.disconnect();
    expect(audioClose).toHaveBeenCalledOnce();
    acquired.resolve(sourceWith(sourceClose, startReceiving));

    await expect(disconnecting).resolves.toBeUndefined();
    expect(await startOutcome).toBe("AbortError");
    expect(startReceiving).not.toHaveBeenCalled();
    expect(sourceClose).toHaveBeenCalledOnce();
    expect(audioClose).toHaveBeenCalledOnce();
  });

  it("does not reactivate reception when transfer startup completes after cancellation", async () => {
    vi.stubGlobal("navigator", { usb: {} });
    const receiving = deferred<void>();
    const sourceClose = vi.fn(async () => {});
    const startReceiving = vi.fn(() => receiving.promise);
    const backendEvents = events();
    backendEvents.runtimeError = vi.fn();
    const backend = new RtlSdrBackend(
      backendEvents,
      undefined,
      1,
      OPTIONS.channelFrequencyHz,
      dependencies(
        sourceWith(sourceClose, startReceiving),
        audioContextWith(async () => {}),
      ),
    );

    const starting = backend.start(OPTIONS, 1);
    const startOutcome = starting.then(
      () => "resolved",
      (error: Error) => error.name,
    );
    await vi.waitFor(() => expect(startReceiving).toHaveBeenCalledOnce());
    const disconnecting = backend.disconnect();
    receiving.resolve();

    await expect(disconnecting).resolves.toBeUndefined();
    expect(await startOutcome).toBe("AbortError");
    expect(sourceClose).toHaveBeenCalledOnce();
    expect(backendEvents.runtimeError).not.toHaveBeenCalled();
  });

  it("keeps the controller's single owner until real teardown retry succeeds", async () => {
    vi.stubGlobal("navigator", { usb: {} });
    let creations = 0;
    let closeAttempts = 0;
    const controller = new ReceiverController(
      (backendEvents, options, generation) => {
        creations += 1;
        const close = vi.fn(async () => {
          if (creations === 1 && ++closeAttempts === 1)
            throw new Error("USB close failed");
        });
        return new RtlSdrBackend(
          backendEvents,
          undefined,
          generation,
          options.channelFrequencyHz,
          dependencies(
            sourceWith(close),
            audioContextWith(async () => {}),
          ),
        );
      },
    );

    await controller.connect(OPTIONS);
    await controller.disconnect();
    expect(controller.getSnapshot()).toMatchObject({
      lifecycle: "error",
      cleanupRequired: true,
    });
    await controller.connect(OPTIONS);
    expect(creations).toBe(1);

    await controller.disconnect();
    expect(controller.getSnapshot()).toMatchObject({ lifecycle: "idle" });
    await controller.connect(OPTIONS);
    expect(creations).toBe(2);
    await controller.disconnect();
  });
});

it("keeps RTL raw fan-out, acknowledged centers and route validation through the shared pipeline", async () => {
  vi.stubGlobal("navigator", { usb: {} });
  type Block = import("@jtarrio/signals/radio/sample_block.js").SampleBlock;
  const reads: ReturnType<typeof deferred<Block>>[] = [];
  const source = sourceWith(async () => {});
  source.readSamples = () => {
    const read = deferred<Block>();
    reads.push(read);
    return read.promise;
  };
  source.setCenterFrequency = async (frequency) => frequency + 17;
  const raw: number[] = [];
  const analysis = {
    begin: vi.fn(() => ({
      setSampleRate: vi.fn(),
      receiveSamples: (block: Block) => raw.push(block.I[0]!),
    })),
    retune: vi.fn(),
    stop: vi.fn(),
  };
  const demodulator = {
    setMode: vi.fn(),
    setVolume: vi.fn(),
    setFrequencyOffset: vi.fn(),
    setSampleRate: vi.fn(),
    expectFrequencyAndSetOffset: vi.fn(),
    receiveSamples: vi.fn((block: Block) => block.I.fill(99)),
  };
  const backend = new RtlSdrBackend(
    events(),
    analysis as unknown as import("../dsp/analysisPipeline").AnalysisPipeline,
    1,
    OPTIONS.channelFrequencyHz,
    {
      ...dependencies(
        source,
        audioContextWith(async () => {}),
      ),
      createDemodulator: () => demodulator,
    },
  );
  const metadata = await backend.start(OPTIONS);
  expect(metadata.hardwareCenterFrequencyHz).toBe(100_000_017);
  expect(demodulator.setFrequencyOffset).toHaveBeenLastCalledWith(-17);
  const block = (frequency: number) => ({
    I: new Float32Array([0.25]),
    Q: new Float32Array([0.5]),
    frequency,
  });
  reads.shift()!.resolve(block(100_000_017));
  for (let n = 0; n < 10; n++) await Promise.resolve();
  expect(raw).toEqual([0.25]);
  expect(demodulator.receiveSamples).toHaveBeenCalledOnce();
  const modeCount = demodulator.setMode.mock.calls.length;
  await expect(
    backend.configureMode(
      { mode: "DAB", bandwidthHz: 1_536_000, squelch: 0 },
      2,
    ),
  ).rejects.toThrow();
  expect(demodulator.setMode).toHaveBeenCalledTimes(modeCount);
  await backend.tune(101_000_000, 3);
  expect(demodulator.setFrequencyOffset).toHaveBeenLastCalledWith(-17);
  reads.shift()!.resolve(block(100_000_017));
  for (let n = 0; n < 10; n++) await Promise.resolve();
  expect(raw).toHaveLength(1);
  reads.shift()!.resolve(block(101_000_017));
  for (let n = 0; n < 10; n++) await Promise.resolve();
  expect(raw).toEqual([0.25, 0.25]);
  const lateTune = deferred<number>();
  source.setCenterFrequency = () => lateTune.promise;
  const tuning = backend.tune(102_000_000, 4);
  const rejected = expect(tuning).rejects.toMatchObject({ name: "AbortError" });
  const disconnecting = backend.disconnect();
  for (const read of reads.splice(0)) read.resolve(block(101_000_017));
  await disconnecting;
  const begins = analysis.begin.mock.calls.length;
  lateTune.resolve(102_000_017);
  await rejected;
  expect(analysis.begin).toHaveBeenCalledTimes(begins);
});

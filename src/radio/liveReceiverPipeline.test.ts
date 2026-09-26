import { describe, expect, it, vi } from "vitest";
import { LiveReceiverPipeline } from "./liveReceiverPipeline";
import { hackrfRecordingFixture } from "../testing/hackrfRecordingFixture";

describe("lazy DAB lifecycle", () => {
  it("allocates only for DAB, retains across retunes, and closes on exit and stop", async () => {
    const createDecoder = vi.fn(() => ({
      prepare: vi.fn(async () => undefined),
      reset: vi.fn(),
      close: vi.fn(),
      setSampleRate: vi.fn(),
      receiveSamples: vi.fn(),
      selectService: vi.fn(),
    }));
    const pipeline = new LiveReceiverPipeline(
      {
        runtimeError: vi.fn(),
        audioStateChanged: vi.fn(),
        rdsChanged: vi.fn(),
        permissionGranted: vi.fn(),
        sourceEnded: vi.fn(),
      },
      undefined,
      {
        createAudioContext: () =>
          ({
            sampleRate: 48000,
            state: "running",
            addEventListener() {},
            removeEventListener() {},
            close: async () => undefined,
          }) as unknown as AudioContext,
        createDemodulator: () => ({
          setMode() {},
          setVolume() {},
          setFrequencyOffset() {},
          setSampleRate() {},
          receiveSamples() {},
          expectFrequencyAndSetOffset() {},
        }),
        createDabEnsembleDecoder: createDecoder,
      },
    );
    const { session } = await hackrfRecordingFixture(undefined, 2_400_000);
    await pipeline.prepare(session);
    pipeline.begin(session, 0.4);
    expect(createDecoder).not.toHaveBeenCalled();
    const dab = {
      ...session,
      mode: "DAB" as const,
      channelBandwidthHz: 1_536_000,
    };
    await pipeline.prepare(dab);
    pipeline.retune(dab);
    pipeline.retune({ ...dab, sessionGeneration: 2 });
    expect(createDecoder).toHaveBeenCalledOnce();
    const first = createDecoder.mock.results[0]!.value;
    expect(first.prepare).toHaveBeenCalledOnce();
    pipeline.selectDabService("service");
    expect(first.selectService).toHaveBeenCalledWith("service");
    pipeline.retune(session);
    expect(first.close).toHaveBeenCalledOnce();
    await pipeline.prepare(dab);
    pipeline.retune(dab);
    expect(createDecoder).toHaveBeenCalledTimes(2);
    pipeline.reset();
    expect(createDecoder.mock.results[1]!.value.close).toHaveBeenCalledOnce();
    await pipeline.close();
    expect(first.close).toHaveBeenCalledOnce();
    expect(createDecoder.mock.results[1]!.value.close).toHaveBeenCalledOnce();
    await expect(pipeline.prepare(dab)).rejects.toThrow("disconnected");
  });
});

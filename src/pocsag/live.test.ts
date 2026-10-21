import { it, expect, vi } from "vitest";
import { LiveReceiverPipeline } from "../radio/liveReceiverPipeline";
import { pocsagRecordingFixture } from "../testing/pocsagRecordingFixture";
import { decodeRecordingSamples } from "../radio/iqRecording";
import type { SourceSessionMetadata } from "../radio/types";
it("the shared live route decodes I/Q without audio, resets gaps and ignores an obsolete RF center", async () => {
  const recording = pocsagRecordingFixture(1200),
    metadata = recording.metadata;
  const changed = vi.fn(),
    error = vi.fn(),
    audioSamples = vi.fn();
  const pipeline = new LiveReceiverPipeline(
    {
      runtimeError: error,
      audioStateChanged: vi.fn(),
      rdsChanged: vi.fn(),
      permissionGranted: vi.fn(),
      sourceEnded: vi.fn(),
      pocsagChanged: changed,
    },
    undefined,
    {
      createAudioContext: () =>
        ({
          sampleRate: 48000,
          state: "running",
          addEventListener() {},
          removeEventListener() {},
          close: async () => {},
        }) as unknown as AudioContext,
      createDemodulator: () => ({
        setMode() {},
        setVolume() {},
        setFrequencyOffset() {},
        setSampleRate() {},
        receiveSamples: audioSamples,
        expectFrequencyAndSetOffset() {},
      }),
    },
  );
  const session: SourceSessionMetadata = {
    source: "synthetic",
    sessionGeneration: 9,
    requestedSampleRateHz: metadata.sampleRateHz,
    actualSampleRateHz: metadata.sampleRateHz,
    hardwareCenterFrequencyHz: metadata.centerFrequencyHz,
    selectedChannelFrequencyHz: metadata.selectedChannelFrequencyHz,
    mode: "POCSAG",
    channelBandwidthHz: 20000,
    squelch: 0,
    pocsag: metadata.pocsag,
    gainDb: null,
    sampleFormat: "planar-f32-iq-normalized",
  };
  await pipeline.prepare(session);
  pipeline.begin(session, 0.3);
  const feed = () => {
    for (let n = 0; n < metadata.sampleCount; n += 32768) {
      const samples = decodeRecordingSamples(
        recording.data.subarray(n * 2, (n + 32768) * 2),
        metadata,
      );
      pipeline.receiveSamples({
        ...samples,
        frequency: metadata.centerFrequencyHz,
      });
    }
  };
  feed();
  expect(changed.mock.calls.at(-1)?.[0].messages).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        text: "POCSAG 1200 DEMO <script>literal text</script>",
        address: 123456,
        complete: true,
      }),
    ]),
  );
  expect(audioSamples).not.toHaveBeenCalled();
  pipeline.markDiscontinuity(null);
  expect(changed.mock.calls.at(-1)?.[0].counters.gaps).toBe(1);
  const next = {
    ...session,
    sessionGeneration: 10,
    hardwareCenterFrequencyHz: session.hardwareCenterFrequencyHz + 25000,
    selectedChannelFrequencyHz: session.selectedChannelFrequencyHz + 25000,
  };
  await pipeline.prepare(next);
  pipeline.retune(next);
  const before = changed.mock.calls.length;
  feed();
  expect(changed).toHaveBeenCalledTimes(before);
  expect(changed.mock.calls.at(-1)?.[0].messages).toHaveLength(0);
  await pipeline.close();
  expect(error).not.toHaveBeenCalled();
});

import { describe, expect, it, vi } from "vitest";
import { applyReceptionCandidate } from "./atlasStationSelection";
import {
  CaptureCandidateLatch,
  type ReceptionCandidate,
} from "./receptionEvidence";
import { ReceiverController, type ReceiverBackend } from "./receiverController";
import type { SourceSessionMetadata } from "./types";
import { createDeterministicRecordingFixture } from "../testing/recordingFixture";
const candidate: ReceptionCandidate = {
  station_id: "00000000-0000-4000-8000-000000000001",
  transmission_id: "00000000-0000-4000-8000-000000000011",
  station_name: "First station",
  frequency_hz: 100e6,
  bandwidth_hz: 200000,
  mode: "WBFM",
};
function peer() {
  let session: Omit<SourceSessionMetadata, "sessionGeneration"> = {
    source: "synthetic",
    requestedSampleRateHz: 1024000,
    actualSampleRateHz: 1024000,
    hardwareCenterFrequencyHz: 100e6,
    selectedChannelFrequencyHz: 100e6,
    mode: "WBFM",
    channelBandwidthHz: 150000,
    squelch: 0,
    gainDb: null,
    sampleFormat: "planar-f32-iq-normalized",
  };
  const backend: ReceiverBackend = {
    start: vi.fn(async () => session),
    stop: async () => {},
    setVolume: () => {},
    setGain: async () => null,
    configureMode: vi.fn(async (settings) => {
      session = {
        ...session,
        mode: settings.mode,
        channelBandwidthHz: settings.bandwidthHz,
      };
      return session;
    }),
    tune: vi.fn(async (frequency) => {
      session = {
        ...session,
        selectedChannelFrequencyHz: frequency,
        hardwareCenterFrequencyHz: frequency,
      };
      return session;
    }),
  };
  const controller = new ReceiverController(() => backend);
  return { controller, backend };
}
describe("explicit station receiver configuration", () => {
  it("configures stopped reception without calling Start/USB and preserves requested vs applied WBFM bandwidth", async () => {
    const { controller, backend } = peer();
    const result = await applyReceptionCandidate(controller, candidate, {
      source: "synthetic",
      channelFrequencyHz: 100e6,
      sampleRateHz: 1024000,
    });
    expect(result.settings.bandwidthHz).toBe(150000);
    expect(result.candidate.bandwidth_hz).toBe(200000);
    expect(backend.start).not.toHaveBeenCalled();
    expect(backend.tune).not.toHaveBeenCalled();
    expect(controller.getSnapshot().lifecycle).toBe("idle");
  });
  it("applies an accepted live analog profile and frequency using controller guards", async () => {
    const { controller, backend } = peer();
    await controller.start({
      source: "synthetic",
      channelFrequencyHz: 100e6,
      volume: 0,
    });
    const result = await applyReceptionCandidate(
      controller,
      { ...candidate, mode: "AM", bandwidth_hz: 10000, frequency_hz: 101e6 },
      { source: "synthetic", channelFrequencyHz: 100e6, sampleRateHz: 1024000 },
    );
    expect(result.candidate.frequency_hz).toBe(101e6);
    expect(controller.getSnapshot().session).toMatchObject({
      mode: "AM",
      selectedChannelFrequencyHz: 101e6,
      channelBandwidthHz: 10000,
    });
    expect(backend.configureMode).toHaveBeenCalledOnce();
    expect(backend.tune).toHaveBeenCalledOnce();
    expect(backend.start).toHaveBeenCalledOnce();
    await controller.stop();
  });
  it("rejects fixed device RF limits before touching reception", async () => {
    const { controller, backend } = peer();
    for (const source of ["bladerf", "usrp-b205"] as const)
      await expect(
        applyReceptionCandidate(
          controller,
          { ...candidate, frequency_hz: 20e6 },
          { source, channelFrequencyHz: 100e6 },
        ),
      ).rejects.toThrow();
    await expect(
      applyReceptionCandidate(
        controller,
        { ...candidate, frequency_hz: 6e9 },
        { source: "hackrf", channelFrequencyHz: 100e6 },
      ),
    ).rejects.toThrow();
    expect(backend.start).not.toHaveBeenCalled();
    expect(backend.tune).not.toHaveBeenCalled();
  });
  it("rejects an out-of-window station before changing the active mode when Follow channel is off", async () => {
    const { controller, backend } = peer();
    await controller.start({ source: "synthetic", channelFrequencyHz: 100e6, volume: 0 });
    controller.setAutoRecenter(false);
    const before = controller.getSnapshot();
    await expect(applyReceptionCandidate(controller,
      { ...candidate, mode: "AM", bandwidth_hz: 10000, frequency_hz: 101e6 },
      { source: "synthetic", channelFrequencyHz: 100e6, sampleRateHz: 1024000 },
    )).rejects.toThrow("Follow channel");
    expect(backend.configureMode).not.toHaveBeenCalled();
    expect(backend.tune).not.toHaveBeenCalled();
    expect(controller.getSnapshot()).toEqual(before);
    await controller.stop();
  });
  it("rejects invalid references and replay without a guessed mode", async () => {
    const { controller } = peer();
    await expect(
      applyReceptionCandidate(controller, candidate, {
        source: "replay",
        channelFrequencyHz: 100e6,
      }),
    ).rejects.toThrow("replay");
    for (const patch of [
      { frequency_hz: NaN },
      { bandwidth_hz: 0 },
      { frequency_hz: Infinity },
    ])
      await expect(
        applyReceptionCandidate(
          controller,
          { ...candidate, ...patch },
          { source: "synthetic", channelFrequencyHz: 100e6 },
        ),
      ).rejects.toThrow();
  });
  it("does not accept a candidate if a backend rejects the live tune or reports a different profile", async () => {
    const { controller, backend } = peer();
    await controller.start({
      source: "synthetic",
      channelFrequencyHz: 100e6,
      volume: 0,
    });
    backend.tune = vi.fn(async () => {
      throw new Error("Hardware rejected frequency");
    });
    await expect(
      applyReceptionCandidate(
        controller,
        { ...candidate, frequency_hz: 101e6 },
        {
          source: "synthetic",
          channelFrequencyHz: 100e6,
          sampleRateHz: 1024000,
        },
      ),
    ).rejects.toThrow("Hardware rejected");
    const other = peer();
    await other.controller.start({
      source: "synthetic",
      channelFrequencyHz: 100e6,
      volume: 0,
    });
    other.backend.configureMode = vi.fn(async () => ({
      ...other.controller.getSnapshot().session!,
      mode: "WBFM" as const,
    }));
    await expect(
      applyReceptionCandidate(
        other.controller,
        { ...candidate, mode: "AM", bandwidth_hz: 10000 },
        {
          source: "synthetic",
          channelFrequencyHz: 100e6,
          sampleRateHz: 1024000,
        },
      ),
    ).rejects.toThrow();
    expect(other.backend.tune).not.toHaveBeenCalled();
    await other.controller.stop();
  });
});
describe("capture candidate boundary", () => {
  function capture() {
    const recording = createDeterministicRecordingFixture(100);
    recording.metadata.reception = {
      source_kind: "synthetic",
      decoded_evidence: [],
    };
    const session = {
      ...recording.metadata,
      sampleFormat: "planar-f32-iq-normalized",
      sessionGeneration: 1,
      requestedSampleRateHz: recording.metadata.sampleRateHz,
      actualSampleRateHz: recording.metadata.sampleRateHz,
      hardwareCenterFrequencyHz: recording.metadata.centerFrequencyHz,
    } satisfies SourceSessionMetadata;
    return { recording, session };
  }
  it("latches a copy at start with the applied bandwidth, preserving origin/bytes and leaving prepared context unchanged", () => {
    const { recording, session } = capture(),
      bytes = recording.data.slice();
    const chosen = {
      ...candidate,
      mode: "AM" as const,
      frequency_hz: session.selectedChannelFrequencyHz,
      bandwidth_hz: 20000,
    };
    const latch = new CaptureCandidateLatch();
    latch.begin(chosen, session);
    chosen.station_name = "Changed while capture active";
    latch.complete(recording);
    expect(recording.metadata.reception?.candidate).toMatchObject({
      station_name: "First station",
      bandwidth_hz: session.channelBandwidthHz,
    });
    const saved = JSON.stringify(recording.metadata.reception);
    latch.begin(
      { ...chosen, station_id: "00000000-0000-4000-8000-000000000099" },
      session,
    );
    expect(JSON.stringify(recording.metadata.reception)).toBe(saved);
    expect(recording.metadata.reception?.source_kind).toBe("synthetic");
    expect(recording.data).toEqual(bytes);
  });
  it("does not label a capture after a manual tune outside the passband, wrong mode or no candidate", () => {
    for (const patch of [{ frequency_hz: 999e6 }, { mode: "WBFM" as const }]) {
      const { recording, session } = capture();
      const latch = new CaptureCandidateLatch();
      latch.begin(
        {
          ...candidate,
          mode: "AM",
          frequency_hz: session.selectedChannelFrequencyHz,
          ...patch,
        },
        session,
      );
      latch.complete(recording);
      expect(recording.metadata.reception?.candidate).toBeUndefined();
    }
    const { recording, session } = capture();
    const latch = new CaptureCandidateLatch();
    latch.begin(undefined, session);
    latch.complete(recording);
    expect(recording.metadata.reception?.candidate).toBeUndefined();
  });
});

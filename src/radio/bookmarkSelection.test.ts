import { describe, expect, it, vi } from "vitest";
import { applyBookmark } from "./bookmarkSelection";
import { ReceiverController, type ReceiverBackend } from "./receiverController";
import type { SourceSessionMetadata } from "./types";
import { defaultModeSettings } from "./receiverConfig";
import type { Bookmark } from "./bookmarks";
const item: Bookmark = {
  id: "00000000-0000-4000-8000-000000000001",
  name: "CW channel",
  frequencyHz: 101e6,
  settings: { ...defaultModeSettings("CW"), beatToneHz: 750 },
  tags: [],
  notes: "",
};
function peer(source: SourceSessionMetadata["source"] = "rtl-sdr") {
  let session: Omit<SourceSessionMetadata, "sessionGeneration"> = {
    source,
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
        squelch: settings.squelch,
        beatToneHz: settings.beatToneHz,
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
describe("favorite recall receiver guards", () => {
  it("recalls stopped settings without any backend call or source switch", async () => {
    const { controller, backend } = peer();
    const result = await applyBookmark(controller, item, {
      source: "rtl-sdr",
      channelFrequencyHz: 100e6,
      sampleRateHz: 1024000,
    });
    expect(result.bookmark).toEqual(item);
    expect(controller.getSnapshot().lifecycle).toBe("idle");
    expect(backend.start).not.toHaveBeenCalled();
    expect(backend.configureMode).not.toHaveBeenCalled();
    expect(backend.tune).not.toHaveBeenCalled();
  });
  it("restores full CW settings and tunes a running receiver without a restart", async () => {
    const { controller, backend } = peer();
    await controller.start({
      source: "rtl-sdr",
      channelFrequencyHz: 100e6,
      volume: 0,
    });
    await applyBookmark(controller, item, {
      source: "rtl-sdr",
      channelFrequencyHz: 100e6,
      sampleRateHz: 1024000,
    });
    expect(controller.getSnapshot().session).toMatchObject({
      mode: "CW",
      beatToneHz: 750,
      selectedChannelFrequencyHz: 101e6,
    });
    expect(backend.configureMode).toHaveBeenCalledWith(
      item.settings,
      expect.any(Number),
    );
    expect(backend.start).toHaveBeenCalledOnce();
    await controller.stop();
  });
  it("keeps an already recalled profile and generation without repeating hardware work", async () => {
    const { controller, backend } = peer();
    await controller.start({ source: "rtl-sdr", channelFrequencyHz: 100e6, volume: 0 });
    await applyBookmark(controller, item, { source: "rtl-sdr", channelFrequencyHz: 100e6 });
    const before = controller.getSnapshot();
    const validate = vi.spyOn(controller, "validateTune");
    await applyBookmark(controller, item, { source: "rtl-sdr", channelFrequencyHz: 101e6 });
    expect(controller.getSnapshot()).toEqual(before);
    expect(validate).toHaveBeenCalledWith(item.frequencyHz, {}, item.settings);
    expect(backend.configureMode).toHaveBeenCalledOnce();
    expect(backend.tune).toHaveBeenCalledOnce();
    expect(backend.start).toHaveBeenCalledOnce();
    const snapshot = vi.spyOn(controller, "getSnapshot").mockReturnValueOnce({ ...before, hardwareSettingsPending: true });
    await expect(applyBookmark(controller, item, { source: "rtl-sdr", channelFrequencyHz: 101e6 })).rejects.toThrow(/operation/);
    snapshot.mockRestore();
    vi.spyOn(controller, "getRecordingStatus").mockReturnValue({} as NonNullable<ReturnType<ReceiverController["getRecordingStatus"]>>);
    await expect(applyBookmark(controller, item, { source: "rtl-sdr", channelFrequencyHz: 101e6 })).rejects.toThrow(/recording/);
    expect(controller.getSnapshot()).toEqual(before);
    vi.mocked(controller.getRecordingStatus).mockRestore();
    await controller.stop();
  });
  it("still applies changed CW settings and tunes a changed frequency", async () => {
    const { controller, backend } = peer();
    await controller.start({ source: "rtl-sdr", channelFrequencyHz: 100e6, volume: 0 });
    await applyBookmark(controller, item, { source: "rtl-sdr", channelFrequencyHz: 100e6 });
    const changed = { ...item, settings: { ...item.settings, beatToneHz: 800 } };
    await applyBookmark(controller, changed, { source: "rtl-sdr", channelFrequencyHz: 101e6 });
    expect(backend.configureMode).toHaveBeenCalledTimes(2);
    expect(controller.getSnapshot().session?.beatToneHz).toBe(800);
    await applyBookmark(controller, { ...changed, frequencyHz: 102e6 }, { source: "rtl-sdr", channelFrequencyHz: 101e6 });
    expect(backend.configureMode).toHaveBeenCalledTimes(2);
    expect(backend.tune).toHaveBeenCalledTimes(2);
    expect(controller.getSnapshot().session).toMatchObject({ selectedChannelFrequencyHz: 102e6, beatToneHz: 800, actualSampleRateHz: 1024000 });
    await controller.stop();
  });
  it("rejects replay, incompatible RF and active recording before receiver mutation", async () => {
    const { controller, backend } = peer();
    await expect(
      applyBookmark(controller, item, {
        source: "replay",
        channelFrequencyHz: 100e6,
      }),
    ).rejects.toThrow(/live source/);
    await expect(
      applyBookmark(
        controller,
        { ...item, frequencyHz: 20e6 },
        { source: "bladerf", channelFrequencyHz: 100e6 },
      ),
    ).rejects.toThrow();
    await controller.start({
      source: "rtl-sdr",
      channelFrequencyHz: 100e6,
      volume: 0,
    });
    vi.spyOn(controller, "getRecordingStatus").mockReturnValue(
      {} as NonNullable<ReturnType<ReceiverController["getRecordingStatus"]>>,
    );
    await expect(
      applyBookmark(controller, item, {
        source: "rtl-sdr",
        channelFrequencyHz: 100e6,
      }),
    ).rejects.toThrow(/recording/);
    expect(backend.configureMode).not.toHaveBeenCalled();
    expect(backend.tune).not.toHaveBeenCalled();
    vi.mocked(controller.getRecordingStatus).mockRestore();
    await controller.stop();
  });
  it("rejects a favorite outside the fixed RF window before changing mode or generation", async () => {
    const { controller, backend } = peer();
    await controller.start({ source: "rtl-sdr", channelFrequencyHz: 100e6, volume: 0 });
    controller.setAutoRecenter(false);
    const before = controller.getSnapshot();
    await expect(applyBookmark(controller, item, {
      source: "rtl-sdr", channelFrequencyHz: 100e6, sampleRateHz: 1024000,
    })).rejects.toThrow(/Follow channel/);
    expect(controller.getSnapshot()).toEqual(before);
    expect(backend.configureMode).not.toHaveBeenCalled();
    expect(backend.tune).not.toHaveBeenCalled();
    controller.setAutoRecenter(true);
    await applyBookmark(controller, item, { source: "rtl-sdr", channelFrequencyHz: 100e6 });
    expect(controller.getSnapshot().session).toMatchObject({ mode: "CW", selectedChannelFrequencyHz: 101e6 });
    expect(backend.start).toHaveBeenCalledOnce();
    await controller.stop();
  });
  it("rejects incompatible running decoder rates and asynchronous receiver rejection", async () => {
    const { controller, backend } = peer();
    await controller.start({
      source: "rtl-sdr",
      channelFrequencyHz: 100e6,
      volume: 0,
    });
    await expect(
      applyBookmark(
        controller,
        { ...item, settings: defaultModeSettings("ADS-B") },
        { source: "rtl-sdr", channelFrequencyHz: 100e6 },
      ),
    ).rejects.toThrow(/Stop reception/);
    expect(backend.configureMode).not.toHaveBeenCalled();
    vi.mocked(backend.configureMode!).mockRejectedValueOnce(
      new Error("Test device rejected profile"),
    );
    await expect(
      applyBookmark(controller, item, {
        source: "rtl-sdr",
        channelFrequencyHz: 100e6,
      }),
    ).rejects.toThrow();
    expect(backend.tune).not.toHaveBeenCalled();
    await controller.stop();
  });
});

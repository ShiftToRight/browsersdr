import { describe, expect, it } from "vitest";
import { FakeHackrfUsb, usbView } from "../testing/hackrfUsbFixture";
import { HackrfTransport, type NativeIqBlock } from "./hackrfTransport";
import { DEFAULT_HACKRF_RX_SETTINGS, HACKRF_STABLE_PROFILE, validateHackrfSessionDetails, type HackrfSampleRateHz } from "./sourceCapabilities";
import { hackrfRecordingFormat } from "./ci8Recording";
import { IqRecorder, parseRecording, recordingMetadataJson } from "./iqRecording";
import type { HackrfSourceSessionMetadata } from "./types";
import type { HackrfConfiguration } from "./hackrfProtocol";

const flush = async () => { for (let n = 0; n < 240; n++) await Promise.resolve(); };
const config = (rate: HackrfSampleRateHz, generation = 1): HackrfConfiguration => ({ generation, sampleRateHz: rate, centerFrequencyHz: 4_300_000_001, settings: { ...DEFAULT_HACKRF_RX_SETTINGS } });
async function setup(api = 0x0110, rate: HackrfSampleRateHz = 1_024_000) {
  const usb = new FakeHackrfUsb(api); let now = 0;
  const transport = new HackrfTransport({}, () => now);
  await transport.open(usb);
  const configured = await transport.configure(config(rate));
  const blocks: NativeIqBlock[] = [];
  async function start() {
    const task = transport.startRx(block => blocks.push({ ...block, bytes: block.bytes.slice() }));
    await flush(); now += 200;
    const discardCount = Math.ceil((rate * .12 + 32768) / 32768);
    for (let n = 0; n < discardCount + 1; n++) { usb.deliver(new Uint8Array(65536)); await flush(); }
    return task;
  }
  return { usb, transport, configured, blocks, start };
}

describe("released Pro firmware compatibility", () => {
  it.each([0x0109, 0x0110])("uses the shared stable command set for API %i at all menu rates", async (api) => {
    for (const rate of [1_024_000, 2_400_000, 4_800_000, 9_600_000, 19_200_000] as const) {
      const f = await setup(api, rate);
      try {
        const ready = await f.start();
        expect(ready.details.capabilities.protocolProfile).toBe(HACKRF_STABLE_PROFILE);
        expect(ready.details).toMatchObject({ nativeSampleRateHz: rate, effectiveSampleRateHz: rate >= 4_800_000 ? 2_400_000 : rate, rateEvidence: "requested-and-acknowledged", fpgaDecimationFactor: rate === 1_024_000 ? 32 : rate === 2_400_000 ? 16 : rate === 4_800_000 ? 8 : rate === 9_600_000 ? 4 : 2 });
        expect(f.usb.fpga.get(2)).toBe(rate === 1_024_000 ? 5 : rate === 2_400_000 ? 4 : rate === 4_800_000 ? 3 : rate === 9_600_000 ? 2 : 1);
        expect(f.usb.fpga.get(1)).toBe(7); // legacy quarter shift is in CTRL, not register 3
        expect(ready.details.captureSettings).toMatchObject({ appliedRateFixed36: null, appliedRfFixed24: null, appliedRotation: null,
          reportedBasebandBandwidthHz: null, reportedAnalogLpfTargetHz: null, settingsEvidence: "usb-acknowledged", stableFpgaControl: 7 });
        expect(f.blocks.length).toBeGreaterThan(0);
        const calls = f.usb.calls;
        expect(calls.every(call => [1, 6, 14, 15, 16, 17, 18, 19, 20, 23, 29, 41, 45, 46, 48, 49, 50, 54].includes(call.setup.request))).toBe(true);
        expect(calls.some(call => call.setup.request === 59 || call.setup.request === 60)).toBe(false);
        expect(calls.filter(call => call.setup.request === 41).every(call => call.direction === "in" && call.length === 40 && call.setup.value === 0 && call.setup.index === 0)).toBe(true);
        expect(calls.find(call => call.setup.request === 48)?.setup.value).toBe(0x36);
        expect(calls.filter(call => [17, 23, 29, 54].includes(call.setup.request)).every(call => call.setup.value === 0)).toBe(true);
        expect(calls.filter(call => call.setup.request === 1).every(call => call.setup.value === 0 || call.setup.value === 1)).toBe(true);
        if (rate === 4_800_000) expect(calls.find(call => call.setup.request === 6)?.bytes).toEqual([0x00, 0x3e, 0x49, 0, 1, 0, 0, 0]);
        if (rate === 9_600_000) expect(calls.find(call => call.setup.request === 6)?.bytes).toEqual([0x00, 0x7c, 0x92, 0, 1, 0, 0, 0]);
        if (rate === 19_200_000) expect(calls.find(call => call.setup.request === 6)?.bytes).toEqual([0x00, 0xf8, 0x24, 1, 1, 0, 0, 0]);
        const frequencies = calls.filter(call => call.setup.request === 16).map(call => call.bytes);
        expect(frequencies.slice(-2)).toEqual([[0xcc, 0x10, 0, 0, 2, 0, 0, 0], [0xcc, 0x10, 0, 0, 1, 0, 0, 0]]);
        expect(calls.filter(call => call.setup.request === 49).map(call => [call.setup.index, call.setup.value])).toEqual([[1, 1], [2, rate === 1_024_000 ? 5 : rate === 2_400_000 ? 4 : rate === 4_800_000 ? 3 : rate === 9_600_000 ? 2 : 1], [3, 0], [4, 0], [5, 0]]);
      } finally { await f.transport.close(); }
    }
  });
  it("restores the firmware-cached tuning/quarter shift across same-center image reloads", async () => {
    const f = await setup();
    try {
      await f.start();
      await f.transport.stopRx();
      await f.transport.configure(config(1_024_000, 2));
      expect(f.usb.fpga.get(1)).toBe(1);
      const ready = await f.start();
      expect(f.usb.fpga.get(1)).toBe(7);
      expect(ready.generation).toBe(2);
      expect(ready.hardwareCenterFrequencyHz).toBe(4_300_000_001);
      expect(f.usb.lifecycle.filter(value => value === "open")).toHaveLength(2);
    } finally { await f.transport.close(); }
  });
  it("keeps stable captures byte-exact and omits unavailable firmware readbacks", async () => {
    const f = await setup();
    try {
      const ready = await f.start();
      const session: HackrfSourceSessionMetadata = { source: "hackrf", sessionGeneration: 1, requestedSampleRateHz: 1_024_000, actualSampleRateHz: 1_024_000,
        hardwareCenterFrequencyHz: ready.hardwareCenterFrequencyHz, selectedChannelFrequencyHz: ready.hardwareCenterFrequencyHz,
        mode: "AM", channelBandwidthHz: 15_000, squelch: 0, gainDb: null, sampleFormat: "planar-f32-iq-normalized", hackrf: ready.details };
      const recorder = new IqRecorder(session, "2026-09-24T00:00:00.000Z", 1024, "Stable nominal rate; no RF/rate readback.", undefined, hackrfRecordingFormat(ready.details));
      recorder.appendCi8(Uint8Array.of(128, 127, 255, 0, 0, 255, 127, 128));
      const recording = recorder.finish();
      const roundTrip = parseRecording(recordingMetadataJson(recording), recording.data.buffer as ArrayBuffer);
      expect(roundTrip.data).toEqual(recording.data);
      expect(roundTrip.metadata).toMatchObject({ rateEvidence: "requested-and-acknowledged", hardware: { protocolProfile: HACKRF_STABLE_PROFILE }, captureSettings: { appliedRfFixed24: null } });
      const bad = structuredClone(ready.details); bad.captureSettings.appliedRfFixed24 = "0";
      expect(() => validateHackrfSessionDetails(bad)).toThrow(/evidence/);
      const liar = structuredClone(ready.details); liar.rateEvidence = "firmware-reported";
      expect(() => validateHackrfSessionDetails(liar)).toThrow();
    } finally { await f.transport.close(); }
  });
  it.each(["m0-short", "m0-mode", "fpga-layout", "gain", "antenna"])("rejects %s without delivering samples or losing ownership", async fault => {
    const usb = new FakeHackrfUsb(0x0110);
    usb.inOverride = setup => {
      if (fault === "m0-short" && setup.request === 41) return Promise.resolve({ status: "ok", data: usbView([0, 0, 0, 0]) });
      if (fault === "m0-mode" && setup.request === 41) return Promise.resolve({ status: "ok", data: usbView(new Uint8Array(40).fill(1)) });
      if (fault === "fpga-layout" && setup.request === 50 && setup.index === 3) return Promise.resolve({ status: "ok", data: usbView([64]) });
      if (fault === "gain" && setup.request === 19) return Promise.resolve({ status: "ok", data: usbView([254]) });
    };
    usb.outOverride = setup => fault === "antenna" && setup.request === 48 ? Promise.resolve({ status: "stall", bytesWritten: 0 }) : undefined;
    const transport = new HackrfTransport(); await transport.open(usb);
    await expect(transport.configure(config(1_024_000))).rejects.toThrow();
    expect(usb.opened).toBe(false); expect(usb.reads).toHaveLength(0);
    await transport.close();
  });
});

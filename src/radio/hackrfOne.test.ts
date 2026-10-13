import { describe, expect, it } from "vitest";
import { FakeHackrfOneUsb } from "../testing/hackrfOneUsbFixture";
import { usbView } from "../testing/hackrfUsbFixture";
import oracle from "../testing/fixtures/hackrf-one/wire-oracle.json";
import { HackrfTransport, type NativeIqBlock } from "./hackrfTransport";
import { DEFAULT_HACKRF_RX_SETTINGS, HACKRF_ONE_PROFILE, sourceCapabilities, validateHackrfSessionDetails } from "./sourceCapabilities";
import { hackrfRecordingFormat } from "./ci8Recording";
import { IqRecorder, parseRecording, recordingMetadataJson } from "./iqRecording";
import { createSigmfExport } from "./sigmf";
import type { HackrfConfiguration } from "./hackrfProtocol";
import type { HackrfSourceSessionMetadata } from "./types";
const flush = async () => { for (let n = 0; n < 250; n++) await Promise.resolve(); };
const config = (generation = 1): HackrfConfiguration => ({ generation, sampleRateHz: 9_600_000, centerFrequencyHz: 100_000_000, settings: { ...DEFAULT_HACKRF_RX_SETTINGS } });
async function setup(usb = new FakeHackrfOneUsb()) {
  let now = 0;
  const transport = new HackrfTransport({}, () => now);
  const identity = await transport.open(usb);
  const session = await transport.configure(config());
  const blocks: NativeIqBlock[] = [];
  async function start() {
    const task = transport.startRx(block => blocks.push({ ...block, bytes: block.bytes.slice() }));
    await flush(); now += 200;
    for (let n = 0; n < 38; n++) { usb.deliver(new Uint8Array(65536)); await flush(); }
    return task;
  }
  return { usb, transport, identity, session, blocks, start };
}
describe("experimental HackRF One", () => {
  it.each([[2, 0, 2], [2, 0x81, 2], [2, 2, 2], [2, 0x83, 2], [4, 4, 8], [4, 0x85, 8]])("discovers board/revision/platform %i/%i/%i without Pro setup", async (board, revision, platform) => {
    const usb = new FakeHackrfOneUsb(); Object.assign(usb, { boardId: board, revision, platform });
    const f = await setup(usb);
    try {
      expect(f.identity.kind).toBe("hackrf-one");
      expect(sourceCapabilities("hackrf", f.identity)).toMatchObject({ label: "HackRF One", frequency: { minimumHz: 1_000_000 }, rates: { valuesHz: [9_600_000] }, gain: { lnaCodes: [0, 8, 16, 24, 32, 40] } });
      expect(f.session.details.capabilities).toMatchObject({ protocolProfile: HACKRF_ONE_PROFILE, standardImageIndex: null, formatEvidence: "firmware-standard-ci8", hardwareValidation: "pending" });
      expect(usb.calls.some(c => [49, 50, 54, 59, 60].includes(c.setup.request))).toBe(false);
    } finally { await f.transport.close(); }
  });
  it("matches the actual compiled libhackrf request oracle and applies cached settings under RX", async () => {
    const f = await setup();
    try {
      expect(f.usb.appliedRate).toBe(0);
      expect(f.usb.calls.filter(c => ![14, 15, 18, 41, 45, 46].includes(c.setup.request)).map(c => ({ direction: c.direction, request: c.setup.request, value: c.setup.value, index: c.setup.index, length: c.length, bytes: c.bytes }))).toEqual(oracle.requests.filter(c => c.operation !== "rx").map(({ direction, request, value, index, length, bytes }) => ({ direction, request, value, index, length, bytes })));

      const ready = await f.start();
      for (const expected of oracle.requests) {
        expect(f.usb.calls.some(call => call.direction === expected.direction && call.setup.request === expected.request && call.setup.value === expected.value && call.setup.index === expected.index && call.length === expected.length && JSON.stringify(call.bytes) === JSON.stringify(expected.bytes))).toBe(true);
      }
      expect(f.usb.appliedRate).toBe(9_600_000); expect(f.usb.appliedFilter).toBe(7_000_000); expect(f.usb.appliedFrequency).toBe(100_000_000);
      expect(ready.details).toMatchObject({ nativeSampleRateHz: 9_600_000, adcSampleRateHz: 9_600_000, fpgaDecimationFactor: 1, effectiveSampleRateHz: 2_400_000 });
      await f.transport.stopRx(); await f.transport.configure(config(2)); await f.start();
      expect(f.usb.appliedFrequency).toBe(100_000_000);
    } finally { await f.transport.close(); }
  });
  it("retains odd/partial pairs in order and records native bytes with truthful One metadata", async () => {
    const f = await setup();
    try {
      const ready = await f.start(); f.blocks.length = 0;
      f.usb.deliver(Uint8Array.of(128, 127, 255)); await flush();
      f.usb.deliver(Uint8Array.of(0, 0, 255)); await flush();
      expect(f.blocks.map(b => [...b.bytes]).flat()).toEqual([128, 127, 255, 0, 0, 255]);
      const session: HackrfSourceSessionMetadata = { source: "hackrf", sessionGeneration: 1, requestedSampleRateHz: 9_600_000, actualSampleRateHz: 9_600_000, hardwareCenterFrequencyHz: 100_000_000, selectedChannelFrequencyHz: 100_000_000, mode: "AM", channelBandwidthHz: 15_000, squelch: 0, gainDb: null, sampleFormat: "planar-f32-iq-normalized", hackrf: ready.details };
      const recorder = new IqRecorder(session, "2026-10-13T00:00:00.000Z", 1024, undefined, undefined, hackrfRecordingFormat(ready.details));
      recorder.appendCi8(Uint8Array.of(128, 127, 255, 0, 0, 255)); const recording = recorder.finish();
      const parsed = parseRecording(recordingMetadataJson(recording), recording.data.buffer as ArrayBuffer);
      expect(parsed.data).toEqual(recording.data);
      const exported = await createSigmfExport(recording);
      expect(exported.metadata.global["core:hw"]).toContain("HackRF One via WebUSB");
      expect(exported.metadata.global["core:description"]).toContain("HackRF One native USB bytes unchanged");
      for (const patch of [{ fpgaDecimationFactor: 4 }, { adcSampleRateHz: 38_400_000 }, { rateEvidence: "firmware-reported" }, { capabilities: { ...ready.details.capabilities, standardImageIndex: 0 } }, { captureSettings: { ...ready.details.captureSettings, stableFpgaControl: 1 } }]) {
        expect(() => validateHackrfSessionDetails({ ...ready.details, ...patch } as typeof ready.details)).toThrow();
      }
    } finally { await f.transport.close(); }
  });
  it.each([0x0105, 0x0109, 0x0113])("rejects unsupported One API %i before optional probes or setup", async api => {
    const usb = new FakeHackrfOneUsb(api); const transport = new HackrfTransport();
    await expect(transport.open(usb)).rejects.toThrow(/USB API 0x0110/);
    expect(usb.calls.every(c => c.direction === "in" && [14, 15].includes(c.setup.request))).toBe(true);
    await transport.close();
  });
  it.each(["revision", "platform", "gain-rx", "m0-short", "filter-stall"])("fails closed on %s", async fault => {
    const usb = new FakeHackrfOneUsb(); const transport = new HackrfTransport();
    if (fault === "revision") usb.revision = 9;
    if (fault === "platform") usb.platform = 16;
    usb.inOverride = setup => {
      if (fault === "m0-short" && setup.request === 41) return Promise.resolve({ status: "ok", data: usbView([0]) });
      if (fault === "gain-rx" && setup.request === 19 && usb.radio.get(0) === 1n) return Promise.resolve({ status: "ok", data: usbView([254]) });
    };
    usb.outOverride = setup => fault === "filter-stall" && setup.request === 7 ? Promise.resolve({ status: "stall", bytesWritten: 0 }) : undefined;
    if (fault === "revision" || fault === "platform") await expect(transport.open(usb)).rejects.toThrow(/identity/);
    else {
      await transport.open(usb);
      if (fault === "gain-rx") { await transport.configure(config()); await expect(transport.startRx(() => { throw new Error("No samples before verification"); })).rejects.toThrow(/gain setter/); }
      else await expect(transport.configure(config())).rejects.toThrow();
    }
    expect(usb.opened).toBe(false); await transport.close();
  });
  it.each([0, 8, 16, 24, 32, 40] as const)("applies One IF gain %i without Pro quantization", async gain => {
    const f = await setup();
    try {
      await f.transport.configure({ ...config(2), settings: { ...DEFAULT_HACKRF_RX_SETTINGS, rxLnaGainCode: gain } });
      const ready = await f.start();
      expect(ready.details.captureSettings.rxLnaGainCode).toBe(gain);
      expect(f.usb.appliedGain.lna).toBe(gain);
    } finally { await f.transport.close(); }
  });
  it("preserves submission order across delayed reads and cleans up pending reads on unplug", async () => {
    const f = await setup();
    try {
      await f.start(); f.blocks.length = 0;
      const pending = f.usb.pendingReads;
      pending[1]!.settled = true; pending[1]!.result.resolve({ status: "ok", data: usbView([3, 4]) }); await flush();
      expect(f.blocks).toHaveLength(0);
      pending[0]!.settled = true; pending[0]!.result.resolve({ status: "ok", data: usbView([1, 2]) }); await flush();
      expect(f.blocks.map(b => [...b.bytes]).flat()).toEqual([1, 2, 3, 4]);
      const failed = f.usb.pendingReads[0]!; failed.settled = true;
      failed.result.reject(new DOMException("Unplugged", "NetworkError")); await flush();
      expect(f.usb.opened).toBe(false);
    } finally { await f.transport.close(); }
  });
  it("rejects Pro rates and gain codes before altering a valid connected One", async () => {
    const f = await setup();
    try {
      const before = f.usb.calls.length;
      await expect(f.transport.configure({ ...config(2), sampleRateHz: 2_400_000 })).rejects.toThrow(/9.6/);
      await expect(f.transport.configure({ ...config(2), settings: { ...DEFAULT_HACKRF_RX_SETTINGS, rxLnaGainCode: 33 } })).rejects.toThrow(/gain code/);
      expect(f.usb.calls.length).toBe(before); expect(f.usb.opened).toBe(true);
    } finally { await f.transport.close(); }
  });
});

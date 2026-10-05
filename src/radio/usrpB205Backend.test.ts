import { describe, expect, it, vi } from "vitest";
import type { SampleBlock } from "@jtarrio/signals/radio/sample_block.js";
import { defaultModeSettings } from "./receiverConfig";
import { USRP_B205_IMAGE } from "./usrpB205Images";
import type { ReceiverBackendEvents, ReceiverStartOptions } from "./receiverController";
import type { UsrpB205Ad9364Driver, UsrpB205RxBoundary } from "./usrpB205RxConfig";
import type { UsrpB205RxTransportEvents, UsrpB205NativeBlock } from "./usrpB205RxTransport";
import type { UsrpB205RequestedConfiguration, UsrpB205SessionDetails } from "./usrpB205Capabilities";
import type { UsrpB205ClaimedBulkIo, UsrpB205Fx3Identity } from "./usrpB205Fx3";
import type { VerifiedUsrpB205Image } from "./usrpB205Images";
import type { VerifiedUsrpB205Firmware } from "./usrpB205Firmware";
import type { UsrpB205ControlLink } from "./usrpB205Control";
import { Usrpb205Backend, type UsrpB205PipelinePort } from "./usrpB205Backend";
import { usrpB205SessionDetails } from "../testing/usrpB205SessionFixture";
import { encodeUsrpB205RxData } from "../testing/usrpB205RxFixture";
import { decodeUsrpB205RxPacket } from "./usrpB205RxVrt";
import { usrpB205FirmwareFixture } from "../testing/usrpB205FirmwareFixture";
import type { UsrpB205WorkerSessionEvents, UsrpB205WorkerSessionPort } from "./usrpB205WorkerSession";
import { createSigmfExport } from "./sigmf";
import { CI16_RECORDING_FORMAT } from "./ci16Recording";

const OPTIONS: ReceiverStartOptions = {
  source: "usrp-b205",
  channelFrequencyHz: 100_000_000,
  volume: 0.4,
  sampleRateHz: 4_800_000,
  modeSettings: defaultModeSettings("AM"),
};

function native(generation: number, sequence = 0): UsrpB205NativeBlock {
  const decoded = decodeUsrpB205RxPacket(
    encodeUsrpB205RxData(sequence, BigInt(sequence * 32), [[32767, -32768]]),
  );
  if (decoded.kind !== "data") throw new Error("expected data packet");
  return {
    nativePacketBytes: decoded.packetBytes,
    bytes: decoded.payloadBytes,
    encoding: "chdr-vrt-sc16-le",
    sampleWordOrder: "i16-msw-q16-lsw",
    bytesPerComplexSample: 4,
    complexSampleCount: 1,
    nativeSampleRateHz: 4_800_000,
    generation,
    sequence,
    timestampTicks: BigInt(sequence * 32),
    firstSampleIndex: sequence,
    receivedAtMonotonicMs: 1,
    endOfBurst: true,
    discontinuityBefore: null,
  };
}

class FakePipeline implements UsrpB205PipelinePort {
  audioState: AudioContextState = "suspended";
  readonly calls: string[] = [];
  readonly samples: SampleBlock[] = [];
  readonly usrpSc16: Array<{ bytes: Uint8Array; frequency: number }> = [];
  readonly sessions: number[] = [];
  readonly gaps: Array<number | null> = [];
  readonly channelDiagnostics = undefined;
  setSampleRate(rate: number): void { this.calls.push(`rate:${rate}`); }
  receiveSamples(block: SampleBlock): void {
    this.samples.push({ I: Float32Array.from(block.I), Q: Float32Array.from(block.Q), frequency: block.frequency });
  }
  receiveUsrpSc16(bytes: Uint8Array, frequency: number): boolean {
    this.usrpSc16.push({ bytes: Uint8Array.from(bytes), frequency });
    return true;
  }
  async resume(): Promise<void> { this.calls.push("resume"); this.audioState = "running"; }
  requireRunning(): void { if (this.audioState !== "running") throw new Error("audio not running"); }
  validateRateBudget(rate: number): void { this.calls.push(`budget:${rate}`); }
  async prepare(metadata: { sessionGeneration: number }): Promise<void> { this.calls.push("prepare"); this.sessions.push(metadata.sessionGeneration); }
  begin(metadata: { sessionGeneration: number }): void { this.calls.push("begin"); this.sessions.push(metadata.sessionGeneration); }
  retune(metadata: { sessionGeneration: number }): void { this.calls.push("retune"); this.sessions.push(metadata.sessionGeneration); }
  markDiscontinuity(value: number | null): void { this.gaps.push(value); }
  reset(): void { this.calls.push("reset"); }
  async suspend(): Promise<void> { this.calls.push("suspend"); this.audioState = "suspended"; }
  async close(): Promise<void> { this.calls.push("close"); this.audioState = "closed"; }
  setVolume(): void {}
  updateAnalogMode(): void {}
  selectDabService(): void {}
}

class FakeTransport implements UsrpB205RxBoundary {
  generation = 0;
  callback?: (block: UsrpB205NativeBlock) => void;
  closeFailures = 0;
  readonly calls: string[] = [];
  constructor(public details: UsrpB205SessionDetails, private readonly events: UsrpB205RxTransportEvents) {}
  get observedSessionDetails() { return structuredClone(this.details); }
  get diagnostics() {
    return { state: "configured", generation: this.generation } as never;
  }
  async start(generation: number, callback: (block: UsrpB205NativeBlock) => void): Promise<void> {
    this.generation = generation; this.callback = callback; this.calls.push(`start:${generation}`);
  }
  async stopAndDrain(): Promise<void> { this.calls.push("stop-drain"); }
  incrementGenerationAndDiscardOldPackets(): void { this.generation++; this.calls.push("generation"); }
  acceptSession(details: UsrpB205SessionDetails): void {
    const next = structuredClone(details);
    if (this.details.observations.timestampRateValidation === "observed")
      next.observations.timestampRateValidation = "observed";
    this.details = next; this.calls.push("accept");
    this.events.generationChanged?.(this.generation, "retune", next);
  }
  resetExpectedRxSequence(): void { this.calls.push("sequence-reset"); }
  async restart(): Promise<void> { this.calls.push("restart"); }
  async close(): Promise<void> {
    this.calls.push("close");
    if (this.closeFailures-- > 0) throw new Error("close failed");
  }
  fail(error: unknown): void { this.events.error?.(error); }
  recover(details = this.details): void {
    this.generation++;
    this.details = structuredClone(details);
    this.events.generationChanged?.(this.generation, "overflow", this.details);
  }
}

class FakeWorkerSession implements UsrpB205WorkerSessionPort {
  readonly calls: string[] = [];
  generation = 0;
  details = usrpB205SessionDetails();
  readonly diagnostics = { connection: null, configuration: null, receive: null };
  constructor(private readonly events: UsrpB205WorkerSessionEvents) {}
  get observedSessionDetails() { return structuredClone(this.details); }
  async initialize(
    serial: string | null,
    _image: VerifiedUsrpB205Image,
    _firmware: VerifiedUsrpB205Firmware,
    requested: UsrpB205RequestedConfiguration,
  ) {
    this.calls.push(`initialize:${serial}`);
    this.details = usrpB205SessionDetails(requested.requestedCenterFrequencyHz, requested.requestedSampleRateHz);
    return structuredClone(this.details);
  }
  async start(generation: number): Promise<void> { this.generation = generation; this.calls.push(`start:${generation}`); }
  async stopAndDrain(): Promise<void> { this.calls.push("stop"); }
  async retune(center: number): Promise<UsrpB205SessionDetails> {
    this.calls.push(`retune:${center}`); this.generation++;
    this.details = usrpB205SessionDetails(center, this.details.nativeSampleRateHz);
    this.events.generationChanged(this.generation, "retune", this.details);
    return structuredClone(this.details);
  }
  async close(): Promise<void> { this.calls.push("close"); }
  samples(bytes = Uint8Array.of(0, 192, 0, 64)): void {
    this.events.usrpSc16(bytes, this.details.configuration.acceptedCenterFrequencyHz, this.generation);
  }
}

function fixture() {
  const pipeline = new FakePipeline();
  const events: ReceiverBackendEvents = {
    permissionGranted: vi.fn(), runtimeError: vi.fn(), audioStateChanged: vi.fn(),
    sourceEnded: vi.fn(), rdsChanged: vi.fn(), statusChanged: vi.fn(),
  };
  const connection = {
    diagnostics: { state: "ready" }, close: vi.fn(async () => undefined),
    claimedBulkIo: () => ({}) as UsrpB205ClaimedBulkIo,
    requestAndOpen: vi.fn(async () => identity), open: vi.fn(async () => identity),
  };
  const control = { start: vi.fn(), close: vi.fn(async () => undefined) };
  let details = usrpB205SessionDetails();
  let transport!: FakeTransport;
  const configurator = {
    diagnostics: { stage: "configured-stopped", rfStateUnknown: false, powerCycleRequired: false },
    initialize: vi.fn(async (request: { requestedCenterFrequencyHz: number; requestedSampleRateHz: 4_800_000 | 9_600_000 | 19_200_000 }) => {
      details = usrpB205SessionDetails(request.requestedCenterFrequencyHz, request.requestedSampleRateHz); return structuredClone(details);
    }),
    startContinuous: vi.fn(async () => undefined),
    stopContinuous: vi.fn(async () => undefined),
    retune: vi.fn(async (center: number, boundary: UsrpB205RxBoundary) => {
      await boundary.stopAndDrain();
      boundary.incrementGenerationAndDiscardOldPackets();
      details = usrpB205SessionDetails(center);
      boundary.acceptSession(details);
      boundary.resetExpectedRxSequence();
      await boundary.restart();
      return structuredClone(details);
    }),
  };
  const backend = new Usrpb205Backend(events, undefined, 1, {
    image: { contract: USRP_B205_IMAGE, bytes: new Uint8Array(), importedAs: "official-member",
      archiveSha256: null, memberSha256: USRP_B205_IMAGE.memberSha256, legacyHash: USRP_B205_IMAGE.legacyHash },
    firmware: usrpB205FirmwareFixture(),
    createAd9364Driver: () => ({}) as UsrpB205Ad9364Driver,
    createConnection: () => connection as never,
    createControl: () => control as unknown as UsrpB205ControlLink,
    createConfigurator: () => configurator,
    createTransport: (_io, _commands, session, rxEvents) => {
      transport = new FakeTransport(session, rxEvents); return transport as never;
    },
    createPipeline: () => pipeline,
  });
  return { backend, pipeline, events, connection, control, configurator, get transport() { return transport; } };
}

const identity: UsrpB205Fx3Identity = {
  kind: "usrp-b205-mini-fx3", vendorId: 0x2500, productId: 0x0022,
  productName: "USRP B205-mini fixture", serialNumber: "FIXTURE",
  descriptorLayoutVerified: true, firmware: { major: 8, minor: 0 }, usbSpeed: 3,
  loaderState: 4, fpgaLegacyHash: 0x1624155e,
  imageSha256: USRP_B205_IMAGE.memberSha256, imageDisposition: "already-compatible",
  claimedInterfaces: [4, 3, 2], fpgaCompatibilityCheck: "pending-chdr-step-04",
};

describe("USRP B205-mini backend integration", () => {
  it("uses a sole-owner device worker for real USB lifecycle and transferable samples", async () => {
    const pipeline = new FakePipeline();
    const events: ReceiverBackendEvents = {
      permissionGranted: vi.fn(), runtimeError: vi.fn(), audioStateChanged: vi.fn(),
      sourceEnded: vi.fn(), rdsChanged: vi.fn(), statusChanged: vi.fn(),
    };
    let worker!: FakeWorkerSession;
    const backend = new Usrpb205Backend(events, undefined, 1, {
      image: { contract: USRP_B205_IMAGE, bytes: new Uint8Array(), importedAs: "official-member",
        archiveSha256: null, memberSha256: USRP_B205_IMAGE.memberSha256, legacyHash: USRP_B205_IMAGE.legacyHash },
      firmware: usrpB205FirmwareFixture(),
      createWorkerSession: (workerEvents) => {
        worker = new FakeWorkerSession(workerEvents); return worker;
      },
      createPipeline: () => pipeline,
    });
    await backend.connectGranted(OPTIONS, { serialNumber: "FIXTURE" } as USBDevice);
    expect(worker.calls).toEqual(["initialize:FIXTURE"]);
    await backend.start(OPTIONS, 4);
    backend.startRecording();
    worker.samples();
    expect(pipeline.usrpSc16).toEqual([{ bytes: Uint8Array.of(0, 192, 0, 64), frequency: 100_000_000 }]);
    expect(backend.stopRecording()!.data).toEqual(Uint8Array.of(0, 64, 0, 192));
    await backend.tune(103_000_000, 5);
    worker.samples();
    expect(pipeline.usrpSc16.at(-1)?.frequency).toBe(103_000_000);
    await backend.stop();
    const originalWorker = worker;
    for (const sampleRateHz of [9_600_000, 19_200_000, 4_800_000]) {
      const previousWorker = worker;
      const restarted = await backend.start({ ...OPTIONS, sampleRateHz }, 6);
      expect(previousWorker.calls.at(-1)).toBe("close");
      expect(worker).not.toBe(previousWorker);
      expect(restarted).toMatchObject({ actualSampleRateHz: sampleRateHz, requestedSampleRateHz: sampleRateHz });
      expect(worker.calls[0]).toBe("initialize:FIXTURE");
      worker.samples();
      expect(pipeline.usrpSc16.at(-1)?.frequency).toBe(OPTIONS.channelFrequencyHz);
      await backend.stop();
    }
    await backend.disconnect();
    expect(originalWorker.calls).toEqual([
      "initialize:FIXTURE", "start:1", "retune:103000000", "stop", "close",
    ]);
  });

  it("connects persistently, resumes audio on start, stops without closing and restarts", async () => {
    const f = fixture();
    const connected = await f.backend.connect(OPTIONS);
    expect(connected).toMatchObject({ source: "usrp-b205", actualSampleRateHz: 4_800_000,
      hardwareCenterFrequencyHz: 100_000_000, gainDb: null });
    expect(f.events.permissionGranted).toHaveBeenCalledOnce();
    await f.backend.start(OPTIONS, 4);
    expect(f.pipeline.calls.indexOf("resume")).toBeLessThan(f.pipeline.calls.indexOf("begin"));
    f.transport.callback?.(native(1));
    expect(f.pipeline.samples).toHaveLength(1);
    await f.backend.stop();
    expect(f.connection.close).not.toHaveBeenCalled();
    await f.backend.start(OPTIONS, 9);
    expect(f.transport.calls).toContain("start:2");
    expect(f.pipeline.sessions).toContain(9);
    await f.backend.disconnect();
    expect(f.transport.calls).toContain("close");
  });

  it("reopens the authorized stopped device for a new rate without a chooser", async () => {
    const f = fixture();
    const device = { serialNumber: "FIXTURE" } as USBDevice;
    await f.backend.connectGranted(OPTIONS, device);
    await f.backend.start(OPTIONS, 1);
    await f.backend.stop();
    const oldTransport = f.transport;
    const metadata = await f.backend.start({ ...OPTIONS, sampleRateHz: 9_600_000 }, 2);
    expect(oldTransport.calls).toContain("close");
    expect(f.connection.open).toHaveBeenCalledTimes(2);
    expect(f.connection.requestAndOpen).not.toHaveBeenCalled();
    expect(metadata.actualSampleRateHz).toBe(9_600_000);
    expect(f.configurator.initialize).toHaveBeenLastCalledWith(expect.objectContaining({requestedSampleRateHz: 9_600_000}));
    await f.backend.disconnect();
  });

  it("retains the old owner if closing for a rate change fails", async () => {
    const f = fixture();
    await f.backend.connectGranted(OPTIONS, { serialNumber: "FIXTURE" } as USBDevice);
    await f.backend.start(OPTIONS, 1);
    await f.backend.stop();
    const close = vi.spyOn(f.transport, "close").mockRejectedValueOnce(new Error("USB close failed"));
    await expect(f.backend.start({ ...OPTIONS, sampleRateHz: 9_600_000 }, 2)).rejects.toThrow("USB close failed");
    expect(f.connection.open).toHaveBeenCalledOnce();
    await f.backend.disconnect();
    expect(close).toHaveBeenCalledTimes(2);
  });

  it("passes the selected 9.6 MS/s profile through configuration, metadata and pipeline budgeting", async () => {
    const rate = 9_600_000 as const;
    const f = fixture();
    const options = { ...OPTIONS, sampleRateHz: rate };
    const connected = await f.backend.connect(options);
    expect(f.configurator.initialize).toHaveBeenCalledWith(expect.objectContaining({
      requestedSampleRateHz: rate,
      requestedBandwidthHz: rate,
    }));
    expect(connected).toMatchObject({ requestedSampleRateHz: rate, actualSampleRateHz: rate });
    expect(f.pipeline.calls).toContain(`budget:${rate}`);
    await f.backend.start(options, 2);
    await f.backend.stop();
    await f.backend.disconnect();
  });

  it("opens an already granted device without invoking the chooser", async () => {
    const f = fixture();
    await f.backend.connectGranted(OPTIONS, {} as USBDevice);
    expect(f.connection.open).toHaveBeenCalledOnce();
    expect(f.connection.requestAndOpen).not.toHaveBeenCalled();
  });

  it("retunes above 2^32 at a clean generation and discards stale blocks", async () => {
    const f = fixture();
    await f.backend.start(OPTIONS, 1);
    const old = f.transport.callback!;
    const result = await f.backend.scanTune(4_300_000_001, 7);
    old(native(1, 1));
    expect(f.pipeline.samples).toHaveLength(0);
    f.transport.callback?.(native(2, 2));
    expect(f.pipeline.samples).toHaveLength(1);
    expect(result).toMatchObject({ hardwareCenterFrequencyHz: 4_300_000_001,
      selectedChannelFrequencyHz: 4_300_000_001,
      usrpB205: { configuration: { centerFrequencyEvidence: "rf-synthesizer-calculated" } } });
    expect(f.transport.calls.slice(-5)).toEqual(["stop-drain", "generation", "accept", "sequence-reset", "restart"]);
  });

  it("serializes mode changes through the same stop/retune/restart boundary", async () => {
    const f = fixture();
    await f.backend.start(OPTIONS, 1);
    const result = await f.backend.configureMode(defaultModeSettings("USB"), 2);
    expect(result.mode).toBe("USB");
    expect(f.configurator.retune).toHaveBeenCalledWith(100_000_000, f.transport);
    expect(f.pipeline.calls).toContain("retune");
  });

  it("publishes immutable evidence and resets diagnostics/decoders for unknown recovery loss", async () => {
    const f = fixture();
    const first = await f.backend.start(OPTIONS, 3);
    first.usrpB205.configuration.acceptedCenterFrequencyHz = 1;
    f.transport.recover({ ...f.transport.details, observations: {
      ...f.transport.details.observations, timestampRateValidation: "observed" } });
    expect(f.pipeline.gaps).toEqual([null]);
    expect(f.backend.diagnostics.receive).not.toBeNull();
    expect(f.backend.getIngressDiagnostics().budgetMs).toBeCloseTo(0.85125, 5);
    expect(await f.backend.tune(100_100_000, 4)).toMatchObject({
      hardwareCenterFrequencyHz: 100_000_000, selectedChannelFrequencyHz: 100_100_000,
      usrpB205: { configuration: { acceptedCenterFrequencyHz: 100_000_000 },
        observations: { timestampRateValidation: "observed" } },
    });
  });

  it("surfaces runtime unplug and retains failed close for retry", async () => {
    const f = fixture();
    await f.backend.start(OPTIONS, 1);
    f.transport.fail(new Error("unplugged"));
    expect(f.events.runtimeError).toHaveBeenCalledWith(expect.objectContaining({ message: "unplugged" }));
    f.transport.closeFailures = 1;
    await expect(f.backend.disconnect()).rejects.toThrow("close failed");
    await f.backend.disconnect();
    expect(f.transport.calls.filter((call) => call === "close")).toHaveLength(2);
  });

  it("records native B205 samples as SigMF ci16_le I/Q without changing sample values", async () => {
    const f = fixture();
    await f.backend.start(OPTIONS, 1);
    expect(f.backend.startRecording()).toMatchObject({ state: "recording", sampleCount: 0 });
    f.transport.callback!({
      ...native(f.transport.generation),
      discontinuityBefore: {
        generation: f.transport.generation,
        missingSamples: 7,
        reason: "fixture timestamp gap",
      },
    });
    const recording = f.backend.stopRecording()!;
    expect(recording.data).toEqual(Uint8Array.of(0xff, 0x7f, 0x00, 0x80));
    expect(recording.metadata).toMatchObject({
      format: CI16_RECORDING_FORMAT,
      source: "usrp-b205",
      sampleEncoding: "signed-16-bit-little-endian",
      bytesPerComplexSample: 4,
      sampleCount: 1,
      knownGaps: [{ afterSample: 0, missingSamples: 7, reason: "fixture timestamp gap" }],
    });
    const exported = await createSigmfExport(recording);
    expect(exported.metadata.global).toMatchObject({
      "core:datatype": "ci16_le",
      "core:sample_rate": 4_800_000,
      "core:hw": expect.stringContaining("USRP B205-mini"),
    });
    await expect(f.backend.setGain(10)).rejects.toThrow(/slow-attack AGC/);
    expect(f.backend.getRecordingStatus()).toBeUndefined();
  });

  it("requires the verified image and RF driver before requesting USB", async () => {
    const pipeline = new FakePipeline();
    const events = { permissionGranted: vi.fn(), runtimeError: vi.fn(), audioStateChanged: vi.fn(),
      sourceEnded: vi.fn(), rdsChanged: vi.fn() } satisfies ReceiverBackendEvents;
    const backend = new Usrpb205Backend(events, undefined, 0, { createPipeline: () => pipeline });
    await expect(backend.connect(OPTIONS)).rejects.toThrow(/Import and verify/);
  });
});

it.each([4_800_000, 9_600_000, 19_200_000] as const)("captures a B205 channel from native Q/I at %i", async (rate) => {
  const f = fixture();
  await f.backend.start({ ...OPTIONS, sampleRateHz: rate }, 1);
  f.backend.startRecording(undefined, { captureCurrentChannel: true });
  for (let sequence = 0; sequence < 32; sequence++) {
    const packet = decodeUsrpB205RxPacket(encodeUsrpB205RxData(sequence, BigInt(sequence * 2048), Array.from({ length: 2048 }, () => [16384, -8192] as const)));
    if (packet.kind !== "data") throw new Error("expected data packet");
    f.transport.callback!({ ...native(f.transport.generation, sequence), nativePacketBytes: packet.packetBytes, bytes: packet.payloadBytes,
      nativeSampleRateHz: rate, complexSampleCount: 2048, firstSampleIndex: sequence * 2048 });
  }
  const recording = f.backend.stopRecording()!;
  expect(recording.metadata).toMatchObject({ format: "browsersdr-channel-iq-v1", source: "usrp-b205", sampleRateHz: 75_000, sampleEncoding: "signed-16-bit-little-endian" });
  const data = new DataView(recording.data.buffer);
  expect(data.getInt16(recording.data.length - 4, true)).toBeGreaterThan(15000);
  expect(data.getInt16(recording.data.length - 2, true)).toBeLessThan(-7000);
  expect(f.events.runtimeError).not.toHaveBeenCalled();
  await f.backend.disconnect();
});


it("tunes USRP channels without changing the capture center and moves center independently", async () => {
  const f = fixture();
  await f.backend.start(OPTIONS, 1);
  const calls = f.transport.calls.length;
  expect(await f.backend.tune(100.1e6, 2)).toMatchObject({
    hardwareCenterFrequencyHz: 100e6, selectedChannelFrequencyHz: 100.1e6,
  });
  expect(f.configurator.retune).not.toHaveBeenCalled();
  expect(f.transport.calls).toHaveLength(calls);
  expect(await f.backend.tune(100.1e6, 3, { centerFrequencyHz: 100.2e6 })).toMatchObject({
    hardwareCenterFrequencyHz: 100.2e6, selectedChannelFrequencyHz: 100.1e6,
  });
  expect(f.configurator.retune).toHaveBeenCalledWith(100.2e6, f.transport);
  await expect(f.backend.tune(104e6, 4, { autoRecenter: false })).rejects.toThrow(/complete channel/);
  expect(f.configurator.retune).toHaveBeenCalledTimes(1);
  await f.backend.disconnect();
});

import { UsrpB205ControlLink } from "../radio/usrpB205Control";
import { UsrpB205RxAccumulator, decodeUsrpB205RxPacket, USRP_B205_RX_TRANSFER_BYTES } from "../radio/usrpB205RxVrt";

interface StartMessage {
  type: "start";
  serialNumber: string | null;
  durationMs: number;
  readSlots: number;
}

interface Stats {
  elapsedMs: number;
  bytes: number;
  transfers: number;
  packets: number;
  dataPackets: number;
  inlinePackets: number;
  overflowPackets: number;
  samples: number;
  sequenceGaps: number;
  pendingReads: number;
  pendingReadsHighWater: number;
  reorderHighWater: number;
  shortTransfers: number;
  zeroTransfers: number;
}

type Completed = { result?: USBInTransferResult; error?: unknown };
const worker = self as unknown as {
  navigator: WorkerNavigator;
  postMessage(message: unknown): void;
  onmessage: ((event: MessageEvent<StartMessage>) => void) | null;
};

function post(type: "progress" | "result" | "error", message: string, stats?: Stats): void {
  worker.postMessage({ type, message, ...(stats ? { stats: { ...stats } } : {}) });
}

async function run(message: StartMessage): Promise<void> {
  const usb = worker.navigator.usb;
  if (!usb?.getDevices) throw new Error("Worker WebUSB getDevices() is unavailable in this Chrome build.");
  const devices = await usb.getDevices();
  const matches = devices.filter((device) => device.vendorId === 0x2500 && device.productId === 0x0022
    && (message.serialNumber === null || device.serialNumber === message.serialNumber));
  if (matches.length !== 1) throw new Error(`Expected one authorized 2500:0022 device; found ${matches.length}.`);
  const device = matches[0]!;
  let control: UsrpB205ControlLink | undefined;
  let running = true;
  let terminalError: unknown;
  const parser = new UsrpB205RxAccumulator();
  const pending = new Set<Promise<void>>();
  const completed = new Map<number, Completed>();
  let nextSubmission = 0;
  let nextCompletion = 0;
  let expectedSequence: number | null = null;
  const started = performance.now();
  const stats: Stats = {
    elapsedMs: 0, bytes: 0, transfers: 0, packets: 0, dataPackets: 0,
    inlinePackets: 0, overflowPackets: 0, samples: 0, sequenceGaps: 0,
    pendingReads: 0, pendingReadsHighWater: 0, reorderHighWater: 0,
    shortTransfers: 0, zeroTransfers: 0,
  };

  const snapshot = (): Stats => ({ ...stats, elapsedMs: performance.now() - started, pendingReads: pending.size });
  let rejectRun: (error: unknown) => void = () => undefined;
  const fail = (error: unknown): void => {
    if (!terminalError) {
      terminalError = error;
      running = false;
      rejectRun(error);
    }
  };

  const drain = (): void => {
    while (running && completed.has(nextCompletion)) {
      const value = completed.get(nextCompletion)!;
      completed.delete(nextCompletion++);
      if (value.error) { fail(value.error); return; }
      const result = value.result!;
      const view = result.data;
      if (result.status !== "ok" || !view) { fail(new Error(`Endpoint 6 returned ${result.status}.`)); return; }
      stats.transfers++;
      stats.bytes += view.byteLength;
      if (view.byteLength === 0) stats.zeroTransfers++;
      if (view.byteLength !== USRP_B205_RX_TRANSFER_BYTES) stats.shortTransfers++;
      try {
        const bytes = new Uint8Array(view.buffer, view.byteOffset, view.byteLength);
        for (const encoded of parser.push(bytes)) {
          const packet = decodeUsrpB205RxPacket(encoded);
          stats.packets++;
          if (expectedSequence !== null && packet.sequence !== expectedSequence) stats.sequenceGaps++;
          expectedSequence = (packet.sequence + 1) & 0xfff;
          if (packet.kind === "data") {
            stats.dataPackets++;
            stats.samples += packet.complexSampleCount;
          } else {
            stats.inlinePackets++;
            if (packet.code === 0x8) stats.overflowPackets++;
          }
        }
      } catch (error) { fail(error); return; }
    }
  };

  const submit = (): void => {
    if (!running) return;
    const submission = nextSubmission++;
    const task = device.transferIn(6, USRP_B205_RX_TRANSFER_BYTES).then(
      (result) => {
        pending.delete(task);
        if (!running) return;
        completed.set(submission, { result });
        stats.reorderHighWater = Math.max(stats.reorderHighWater, completed.size);
        submit();
        drain();
      },
      (error: unknown) => {
        pending.delete(task);
        if (!running) return;
        completed.set(submission, { error });
        submit();
        drain();
      },
    );
    pending.add(task);
    stats.pendingReadsHighWater = Math.max(stats.pendingReadsHighWater, pending.size);
  };

  try {
    if (!device.opened) await device.open();
    if (device.configuration?.configurationValue !== 1) await device.selectConfiguration(1);
    for (const number of [4, 3, 2]) await device.claimInterface(number);
    const io = {
      transferControlOut: (data: BufferSource) => device.transferOut(4, data),
      transferControlIn: (length: number) => device.transferIn(8, length),
      transferRxIn: (length: number) => device.transferIn(6, length),
      clearRxHalt: () => device.clearHalt
        ? device.clearHalt("in", 6)
        : Promise.reject(new Error("WebUSB clearHalt is unavailable.")),
    };
    control = new UsrpB205ControlLink(io, { onFatal: fail });
    control.start();
    const compatibility = await control.peek64(0x40, 0);
    if (Number((compatibility >> 32n) & 0xffff_ffffn) !== 0xace0ba5e
      || Number(compatibility & 0xffff_ffffn) >>> 16 !== 7) {
      throw new Error("B205 FPGA compatibility is not ACE0BA5E/7.x.");
    }
    if (((await control.peek32(0x40, 20)) >>> 8 & 0xff) !== 1)
      throw new Error("B205 FPGA did not report one radio chain.");
    if (((await control.peek32(0x40, 24)) & 0x2) === 0)
      throw new Error("B205 RX PLL is not locked; rerun the UHD baseline first.");
    // UHD has already established the 38.4 MHz AD9364 RX-only state. Reassert
    // only the volatile RX FPGA registers needed for the 19.2 MS/s raw test.
    await control.poke32(0x40, 48 * 4, 2);
    await control.poke32(0x10, 13 * 4, 0x4c);
    for (const [setting, value] of [[136, 0], [147, 0], [144, 0], [145, 0x9b57],
      [146, 0x201], [100, 4086], [101, 0xa0]] as const) {
      await control.poke32(0x10, setting * 4, value);
    }
    if (device.clearHalt) await device.clearHalt("in", 6);
    for (let index = 0; index < message.readSlots; index++) submit();
    await control.poke32(0x10, 96 * 4, 0xe0000001);
    await control.poke32(0x10, 97 * 4, 0);
    await control.poke32(0x10, 98 * 4, 0);

    const progress = setInterval(() => post("progress", "raw receive running", snapshot()), 1_000);
    try {
      await new Promise<void>((resolve, reject) => {
        rejectRun = reject;
        setTimeout(resolve, message.durationMs);
      });
    } finally { clearInterval(progress); }
  } finally {
    running = false;
    if (control && !terminalError) {
      try {
        await control.safetyPokes([
          { sid: 0x10, byteAddress: 96 * 4, value: 0x90000000 },
          { sid: 0x10, byteAddress: 97 * 4, value: 0 },
          { sid: 0x10, byteAddress: 98 * 4, value: 0 },
          ...[12, 13, 14, 15].map((setting) => ({ sid: 0x10 as const, byteAddress: setting * 4, value: 0x48 })),
        ]);
      } catch (error) { terminalError ??= error; }
    }
    await control?.close();
    try { if (device.opened) await device.close(); }
    catch (error) { terminalError ??= error; }
  }
  const final = snapshot();
  if (terminalError) throw terminalError;
  post("result", final.overflowPackets || final.sequenceGaps ? "completed with discontinuities" : "completed cleanly", final);
}

worker.onmessage = (event: MessageEvent<StartMessage>) => {
  if (event.data.type !== "start") return;
  void run(event.data).catch((error: unknown) => post("error", String(error)));
};

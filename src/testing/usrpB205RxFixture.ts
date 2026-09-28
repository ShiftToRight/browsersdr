import type { UsrpB205ClaimedBulkIo } from "../radio/usrpB205Fx3";
import type { UsrpB205RxCommands } from "../radio/usrpB205RxTransport";

interface Deferred<T> { promise: Promise<T>; resolve(value: T): void; reject(error: unknown): void }
function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

export interface FakeUsrpB205RxRead {
  readonly requestedLength: number;
  readonly deferred: Deferred<USBInTransferResult>;
  settled: boolean;
}

export class FakeUsrpB205RxIo implements UsrpB205ClaimedBulkIo {
  readonly reads: FakeUsrpB205RxRead[] = [];
  controlOutCount = 0;
  controlInCount = 0;
  clearRxHaltCount = 0;

  transferControlOut(_data: BufferSource): Promise<USBOutTransferResult> {
    this.controlOutCount++;
    throw new Error("RX fixture forbids data/control OUT through the receive transport.");
  }
  transferControlIn(_length: number): Promise<USBInTransferResult> {
    this.controlInCount++;
    throw new Error("RX fixture does not model the separate control link.");
  }
  transferRxIn(length: number): Promise<USBInTransferResult> {
    const value = { requestedLength: length, deferred: deferred<USBInTransferResult>(), settled: false };
    this.reads.push(value);
    return value.deferred.promise;
  }
  async clearRxHalt(): Promise<void> { this.clearRxHaltCount++; }

  resolve(index: number, bytes: Uint8Array, status: USBInTransferResult["status"] = "ok", prefix = 0): void {
    const read = this.reads[index]!;
    if (read.settled) throw new Error(`RX fixture read ${index} already settled.`);
    read.settled = true;
    const backing = new Uint8Array(prefix + bytes.byteLength + 3);
    backing.set(bytes, prefix);
    read.deferred.resolve({ status, data: new DataView(backing.buffer, prefix, bytes.byteLength) });
  }

  reject(index: number, error: unknown): void {
    const read = this.reads[index]!;
    if (read.settled) throw new Error(`RX fixture read ${index} already settled.`);
    read.settled = true;
    read.deferred.reject(error);
  }

  settlePending(): void {
    for (let index = 0; index < this.reads.length; index += 1) {
      if (!this.reads[index]!.settled) this.resolve(index, new Uint8Array());
    }
  }
}

export class FakeUsrpB205RxCommands implements UsrpB205RxCommands {
  starts = 0;
  stops = 0;
  startHook?: () => void | Promise<void>;
  stopHook?: () => void | Promise<void>;
  async startContinuous(): Promise<void> { this.starts++; await this.startHook?.(); }
  async stopContinuous(): Promise<void> { this.stops++; await this.stopHook?.(); }
}

export function encodeUsrpB205RxData(
  sequence: number,
  timestampTicks: bigint,
  samples: readonly (readonly [number, number])[],
  endOfBurst = false,
): Uint8Array {
  const output = new Uint8Array(16 + samples.length * 4);
  const view = new DataView(output.buffer);
  view.setUint32(0, (0x20000000 | (endOfBurst ? 0x10000000 : 0) | ((sequence & 0xfff) << 16) | output.byteLength) >>> 0, true);
  view.setUint32(4, 0xa0, true);
  view.setUint32(8, Number((timestampTicks >> 32n) & 0xffff_ffffn), true);
  view.setUint32(12, Number(timestampTicks & 0xffff_ffffn), true);
  samples.forEach(([i, q], index) => {
    view.setInt16(16 + index * 4, q, true);
    view.setInt16(18 + index * 4, i, true);
  });
  return output;
}

export function encodeUsrpB205RxInline(sequence: number, timestampTicks: bigint, code: number, detail = 0): Uint8Array {
  const output = new Uint8Array(24);
  const view = new DataView(output.buffer);
  view.setUint32(0, (0xa0000018 | ((sequence & 0xfff) << 16)) >>> 0, true);
  view.setUint32(4, 0xa0, true);
  view.setUint32(8, Number((timestampTicks >> 32n) & 0xffff_ffffn), true);
  view.setUint32(12, Number(timestampTicks & 0xffff_ffffn), true);
  view.setUint32(16, code, true);
  view.setUint32(20, detail, true);
  return output;
}

import type { UsrpB205ClaimedBulkIo } from "../radio/usrpB205Fx3";

interface Deferred<T> { promise: Promise<T>; resolve(value: T): void; reject(reason: unknown): void }
function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

export function encodeUsrpB205ControlAck(
  request: Uint8Array,
  options: { sequence?: number; responseSid?: number; readback?: bigint; timestamp?: bigint } = {},
): Uint8Array {
  const input = new DataView(request.buffer, request.byteOffset, request.byteLength);
  const requestSid = input.getUint32(4, true);
  const sequence = options.sequence ?? ((input.getUint32(0, true) >>> 16) & 0xfff);
  const responseSid = options.responseSid ?? (requestSid === 0x40 ? 0x00400000 : 0x00100000);
  const timestamp = options.timestamp ?? 0n;
  const readback = options.readback ?? 0n;
  const output = new Uint8Array(24);
  const view = new DataView(output.buffer);
  view.setUint32(0, (0xa0000018 | (sequence << 16)) >>> 0, true);
  view.setUint32(4, responseSid, true);
  view.setUint32(8, Number((timestamp >> 32n) & 0xffff_ffffn), true);
  view.setUint32(12, Number(timestamp & 0xffff_ffffn), true);
  view.setUint32(16, Number((readback >> 32n) & 0xffff_ffffn), true);
  view.setUint32(20, Number(readback & 0xffff_ffffn), true);
  return output;
}

export class FakeUsrpB205ControlIo implements UsrpB205ClaimedBulkIo {
  readonly writes: Uint8Array[] = [];
  readonly rxReads: number[] = [];
  autoRespond = true;
  responseFor = (request: Uint8Array): Uint8Array => encodeUsrpB205ControlAck(request);
  outStatus: USBOutTransferResult["status"] = "ok";
  outLengthDelta = 0;
  private readonly incoming: Array<USBInTransferResult | Error> = [];
  private readonly readers: Array<Deferred<USBInTransferResult>> = [];

  transferControlOut(data: BufferSource): Promise<USBOutTransferResult> {
    const source = ArrayBuffer.isView(data)
      ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
      : new Uint8Array(data);
    const copy = Uint8Array.from(source);
    this.writes.push(copy);
    if (this.autoRespond) queueMicrotask(() => this.push(this.responseFor(copy)));
    return Promise.resolve({ status: this.outStatus, bytesWritten: copy.byteLength + this.outLengthDelta });
  }

  transferControlIn(_length: number): Promise<USBInTransferResult> {
    const next = this.incoming.shift();
    if (next) return next instanceof Error ? Promise.reject(next) : Promise.resolve(next);
    const reader = deferred<USBInTransferResult>();
    this.readers.push(reader);
    return reader.promise;
  }

  transferRxIn(length: number): Promise<USBInTransferResult> {
    this.rxReads.push(length);
    return new Promise(() => undefined);
  }

  clearRxHalt(): Promise<void> { return Promise.resolve(); }

  push(bytes: Uint8Array, status: USBInTransferResult["status"] = "ok"): void {
    const result = { status, data: new DataView(Uint8Array.from(bytes).buffer) } satisfies USBInTransferResult;
    const reader = this.readers.shift();
    if (reader) reader.resolve(result); else this.incoming.push(result);
  }

  fail(error = new DOMException("fixture unplug", "NetworkError")): void {
    const reader = this.readers.shift();
    if (reader) reader.reject(error); else this.incoming.push(error);
  }
}

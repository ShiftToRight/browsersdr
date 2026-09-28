import type { UsrpB205ClaimedBulkIo } from "./usrpB205Fx3";
import {
  UsrpB205ControlAccumulator,
  decodeUsrpB205ControlResponse,
  encodeUsrpB205ControlRequest,
  type UsrpB205ControlResponse,
  type UsrpB205ControlSid,
} from "./usrpB205Vrt";

const LOCAL_POKES = new Set([8, 9, 10, 16, 48]);
const RADIO_POKES = new Set([12, 13, 14, 15, 16, 17, 96, 97, 98, 100, 101, 128, 129, 130, 136, 144, 145, 146, 147]);
const LOCAL_READBACKS = new Set([0, 8, 20, 24]);

export const USRP_B205_CONTROL_ALLOWLIST = Object.freeze({
  localPokeSettings: Object.freeze([...LOCAL_POKES]),
  localReadbackByteAddresses: Object.freeze([...LOCAL_READBACKS]),
  radioPokeSettings: Object.freeze([...RADIO_POKES]),
  endpointOut: 4,
  endpointIn: 8,
  forbiddenEndpointOut: 2,
});

export interface UsrpB205ControlDiagnostic {
  readonly kind: "unrelated-response" | "sequence-mismatch";
  readonly expectedSid: number | null;
  readonly expectedSequence: number | null;
  readonly actualSid: number;
  readonly actualSequence: number;
}

export interface UsrpB205ControlOptions {
  acknowledgementTimeoutMs?: number;
  onFatal?(error: unknown): void | Promise<void>;
  onDiagnostic?(diagnostic: UsrpB205ControlDiagnostic): void;
}

interface Pending {
  readonly sid: UsrpB205ControlSid;
  readonly sequence: number;
  readonly resolve: (response: UsrpB205ControlResponse) => void;
  readonly reject: (error: unknown) => void;
}

interface Job {
  readonly run: () => Promise<bigint>;
  readonly resolve: (value: bigint) => void;
  readonly reject: (error: unknown) => void;
}

export interface UsrpB205SafetyPoke {
  readonly sid: UsrpB205ControlSid;
  readonly byteAddress: number;
  readonly value: number;
}

const abortError = () => new DOMException("USRP B205-mini control was cancelled.", "AbortError");
const timeoutError = (
  transmitted: boolean,
  receivedBytes: number,
  retainedBytes: number,
  diagnostic: UsrpB205ControlDiagnostic | null,
  sid: UsrpB205ControlSid,
  wireAddress: number,
  sequence: number,
) => new DOMException(
  `USRP B205-mini control acknowledgement timed out ${transmitted
    ? "after endpoint 4 accepted the 16-byte request"
    : "while the endpoint 4 request was still pending"}; endpoint 8 delivered ${receivedBytes} byte(s)${
      retainedBytes ? ` with ${retainedBytes} partial byte(s) retained` : ""
    }${diagnostic
      ? `; last response was ${diagnostic.kind} SID 0x${diagnostic.actualSid.toString(16)} sequence ${diagnostic.actualSequence}`
      : ""}; pending SID 0x${sid.toString(16)} address ${wireAddress} sequence ${sequence}. The session is ambiguous and must close.`,
  "TimeoutError",
);

function resultBytes(result: USBInTransferResult): Uint8Array {
  return result.data ? new Uint8Array(result.data.buffer, result.data.byteOffset, result.data.byteLength) : new Uint8Array();
}

/** Serialized, RX-only endpoint-4/8 CHDR control owner. */
export class UsrpB205ControlLink {
  private readonly accumulator = new UsrpB205ControlAccumulator();
  private readonly sequence = new Map<UsrpB205ControlSid, number>([[0x40, 0], [0x10, 0]]);
  private readonly jobs: Job[] = [];
  private pending: Pending | null = null;
  private running = false;
  private receiving = false;
  private draining = false;
  private fatalError: unknown = null;
  private generation = 0;
  private receivedControlBytes = 0;
  private lastDiagnostic: UsrpB205ControlDiagnostic | null = null;

  constructor(private readonly io: UsrpB205ClaimedBulkIo, private readonly options: UsrpB205ControlOptions = {}) {}

  start(): void {
    if (this.running) return;
    if (this.fatalError) throw this.fatalError;
    this.running = true;
    const generation = ++this.generation;
    this.receiving = true;
    void this.receiveLoop(generation).finally(() => { if (generation === this.generation) this.receiving = false; });
  }

  async close(reason: unknown = abortError()): Promise<void> {
    this.running = false;
    this.receiving = false;
    ++this.generation;
    this.accumulator.reset();
    this.pending?.reject(reason);
    this.pending = null;
    for (const job of this.jobs.splice(0)) job.reject(reason);
  }

  poke32(sid: UsrpB205ControlSid, byteAddress: number, value: number): Promise<void> {
    this.validatePoke(sid, byteAddress, value);
    return this.enqueue(sid, byteAddress / 4, value).then(() => undefined);
  }

  peek64(sid: UsrpB205ControlSid, byteAddress: number): Promise<bigint> {
    this.validatePeek(sid, byteAddress, 8);
    return this.enqueue(sid, 32, byteAddress / 8);
  }

  async peek32(sid: UsrpB205ControlSid, byteAddress: number): Promise<number> {
    this.validatePeek(sid, byteAddress, 4);
    const pair = await this.enqueue(sid, 32, Math.floor(byteAddress / 8));
    return (byteAddress / 4) % 2 === 0 ? Number(pair & 0xffff_ffffn) : Number((pair >> 32n) & 0xffff_ffffn);
  }

  /** Rejects ordinary queued work and runs immediately after the current acknowledgement. */
  safetyPokes(commands: readonly UsrpB205SafetyPoke[]): Promise<void> {
    for (const command of commands) this.validatePoke(command.sid, command.byteAddress, command.value);
    if (!this.running) return Promise.reject(this.fatalError ?? new DOMException("USRP B205-mini control link is not running.", "InvalidStateError"));
    const cancellation = new DOMException("USRP B205-mini queued control was cancelled by a safety operation.", "AbortError");
    for (const job of this.jobs.splice(0)) job.reject(cancellation);
    return new Promise<void>((resolve, reject) => {
      this.jobs.unshift({
        run: async () => {
          for (const command of commands) await this.transact(command.sid, command.byteAddress / 4, command.value);
          return 0n;
        },
        resolve: () => resolve(),
        reject,
      });
      void this.drain();
    });
  }

  private validatePoke(sid: UsrpB205ControlSid, byteAddress: number, value: number): void {
    if (!Number.isSafeInteger(byteAddress) || byteAddress < 0 || byteAddress % 4 !== 0
      || !Number.isInteger(value) || value < 0 || value > 0xffff_ffff) {
      throw new Error("USRP B205-mini poke requires an aligned byte address and unsigned 32-bit value.");
    }
    const setting = byteAddress / 4;
    const allowed = sid === 0x40 ? LOCAL_POKES.has(setting) : sid === 0x10 && RADIO_POKES.has(setting);
    if (!allowed) throw new Error(`Forbidden USRP B205-mini control poke SID 0x${sid.toString(16)} setting ${setting}.`);
    if (sid === 0x10 && setting >= 12 && setting <= 15 && (value & 0x80) !== 0) {
      throw new Error("Forbidden USRP B205-mini ATR TX_ENABLE1 bit.");
    }
  }

  private validatePeek(sid: UsrpB205ControlSid, byteAddress: number, alignment: number): void {
    if (sid !== 0x40 || !Number.isSafeInteger(byteAddress) || byteAddress < 0 || byteAddress % alignment !== 0
      || !LOCAL_READBACKS.has(byteAddress)) {
      throw new Error(`Forbidden or unaligned USRP B205-mini readback SID 0x${sid.toString(16)} address ${byteAddress}.`);
    }
  }

  private enqueue(sid: UsrpB205ControlSid, wireAddress: number, value: number): Promise<bigint> {
    if (!this.running) return Promise.reject(this.fatalError ?? new DOMException("USRP B205-mini control link is not running.", "InvalidStateError"));
    if (this.jobs.length >= 16) return Promise.reject(new DOMException("USRP B205-mini control queue is full (16 commands).", "QuotaExceededError"));
    return new Promise<bigint>((resolve, reject) => {
      this.jobs.push({ run: () => this.transact(sid, wireAddress, value), resolve, reject });
      void this.drain();
    });
  }

  private async drain(): Promise<void> {
    if (this.draining) return;
    this.draining = true;
    try {
      while (this.running && this.jobs.length) {
        const job = this.jobs.shift()!;
        try { job.resolve(await job.run()); }
        catch (error) { job.reject(error); if (this.fatalError) break; }
      }
    } finally { this.draining = false; }
  }

  private transact(sid: UsrpB205ControlSid, wireAddress: number, value: number): Promise<bigint> {
    const sequence = this.sequence.get(sid)!;
    const bytes = encodeUsrpB205ControlRequest(sid, sequence, wireAddress, value);
    return new Promise<bigint>((resolve, reject) => {
      let settled = false;
      let transmitted = false;
      let acknowledgement: UsrpB205ControlResponse | null = null;
      const finishReject = (error: unknown) => { if (!settled) { settled = true; clearTimeout(timer); reject(error); } };
      const finishIfComplete = () => {
        if (!settled && transmitted && acknowledgement) {
          settled = true;
          clearTimeout(timer);
          resolve(acknowledgement.readback);
        }
      };
      const acceptAck = (response: UsrpB205ControlResponse) => { acknowledgement = response; finishIfComplete(); };
      const timer = setTimeout(() => {
        if (this.pending?.sid === sid && this.pending.sequence === sequence) this.pending = null;
        const error = timeoutError(
          transmitted,
          this.receivedControlBytes,
          this.accumulator.retainedByteLength,
          this.lastDiagnostic,
          sid,
          wireAddress,
          sequence,
        );
        finishReject(error);
        void this.fatal(error);
      }, this.options.acknowledgementTimeoutMs ?? 2_000);
      this.pending = { sid, sequence, resolve: acceptAck, reject: finishReject };
      void this.io.transferControlOut(bytes.buffer as ArrayBuffer).then((result) => {
        if (result.status !== "ok" || result.bytesWritten !== 16) {
          throw new DOMException(`USRP B205-mini endpoint 4 returned ${result.status} with ${result.bytesWritten}/16 bytes.`, "NetworkError");
        }
        this.sequence.set(sid, (sequence + 1) & 0xfff);
        transmitted = true;
        finishIfComplete();
      }).catch((error: unknown) => {
        if (this.pending?.sid === sid && this.pending.sequence === sequence) this.pending = null;
        finishReject(error);
        void this.fatal(error);
      });
    });
  }

  private async receiveLoop(generation: number): Promise<void> {
    try {
      while (this.running && generation === this.generation) {
        const result = await this.io.transferControlIn(1024);
        if (!this.running || generation !== this.generation) return;
        const bytes = resultBytes(result);
        if (result.status !== "ok" || bytes.byteLength === 0 || bytes.byteLength > 1024) {
          throw new DOMException(`USRP B205-mini endpoint 8 returned ${result.status} with ${bytes.byteLength} bytes.`, "NetworkError");
        }
        this.receivedControlBytes += bytes.byteLength;
        for (const encoded of this.accumulator.push(bytes)) this.accept(decodeUsrpB205ControlResponse(encoded));
      }
    } catch (error) {
      if (this.running && generation === this.generation) await this.fatal(error);
    }
  }

  private accept(response: UsrpB205ControlResponse): void {
    const pending = this.pending;
    const expectedResponseSid = pending?.sid === 0x40 ? 0x00400000 : 0x00100000;
    if (!pending || response.sid !== expectedResponseSid) {
      const diagnostic: UsrpB205ControlDiagnostic = { kind: "unrelated-response", expectedSid: pending?.sid ?? null,
        expectedSequence: pending?.sequence ?? null, actualSid: response.sid, actualSequence: response.sequence };
      this.lastDiagnostic = diagnostic;
      this.options.onDiagnostic?.(diagnostic);
      return;
    }
    if (response.sequence !== pending.sequence) {
      const diagnostic: UsrpB205ControlDiagnostic = { kind: "sequence-mismatch", expectedSid: pending.sid,
        expectedSequence: pending.sequence, actualSid: response.sid, actualSequence: response.sequence };
      this.lastDiagnostic = diagnostic;
      this.options.onDiagnostic?.(diagnostic);
      const error = new Error(`USRP B205-mini control sequence mismatch: expected ${pending.sequence}, received ${response.sequence}.`);
      this.pending = null;
      pending.reject(error);
      void this.fatal(error);
      return;
    }
    this.pending = null;
    pending.resolve(response);
  }

  private async fatal(error: unknown): Promise<void> {
    if (this.fatalError) return;
    this.fatalError = error;
    await this.close(error);
    await this.options.onFatal?.(error);
  }

  get outstandingCommands(): number { return this.pending ? 1 : 0; }
  get queuedCommands(): number { return this.jobs.length; }
  get hasPendingReceive(): boolean { return this.receiving; }
}

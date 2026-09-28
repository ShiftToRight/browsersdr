import type { UsrpB205RequestedConfiguration, UsrpB205SessionDetails } from "./usrpB205Capabilities";
import type { UsrpB205ConfigurationDiagnostics } from "./usrpB205RxConfig";
import type { UsrpB205Discontinuity, UsrpB205RxTransportDiagnostics } from "./usrpB205RxTransport";
import type { UsrpB205Fx3Diagnostics } from "./usrpB205Fx3";
import type { VerifiedUsrpB205Image } from "./usrpB205Images";
import type { VerifiedUsrpB205Firmware } from "./usrpB205Firmware";

export interface UsrpB205WorkerDiagnostics {
  readonly connection: UsrpB205Fx3Diagnostics | null;
  readonly configuration: UsrpB205ConfigurationDiagnostics | null;
  readonly receive: UsrpB205RxTransportDiagnostics | null;
}

export type UsrpB205WorkerRequest =
  | { type: "initialize"; id: number; serialNumber: string | null; image: VerifiedUsrpB205Image; firmware: VerifiedUsrpB205Firmware; requested: UsrpB205RequestedConfiguration }
  | { type: "start"; id: number; generation: number }
  | { type: "stop"; id: number }
  | { type: "retune"; id: number; centerFrequencyHz: number }
  | { type: "close"; id: number }
  | { type: "sample-consumed"; generation: number };
export type UsrpB205WorkerCommandRequest = Exclude<UsrpB205WorkerRequest, { type: "sample-consumed" }>;
type UsrpB205WorkerCommand = UsrpB205WorkerCommandRequest extends infer Request
  ? Request extends { id: number } ? Omit<Request, "id"> : never
  : never;

export type UsrpB205WorkerResponse =
  | { type: "response"; id: number; details?: UsrpB205SessionDetails; diagnostics: UsrpB205WorkerDiagnostics }
  | { type: "response-error"; id: number; message: string; diagnostics: UsrpB205WorkerDiagnostics }
  | { type: "usrp-sc16-packets"; generation: number; frequency: number; packets: ArrayBuffer[] }
  | { type: "discontinuity"; value: UsrpB205Discontinuity }
  | { type: "generation"; generation: number; reason: string; details: UsrpB205SessionDetails }
  | { type: "fatal"; message: string; diagnostics: UsrpB205WorkerDiagnostics };

export type UsrpB205WorkerPort = Pick<Worker, "postMessage" | "terminate" | "onmessage" | "onerror">;

export interface UsrpB205WorkerSessionEvents {
  usrpSc16(bytes: Uint8Array, frequency: number, generation: number): void;
  discontinuity(value: UsrpB205Discontinuity): void;
  generationChanged(generation: number, reason: string, details: UsrpB205SessionDetails): void;
  error(error: unknown): void;
}

export interface UsrpB205WorkerSessionPort {
  readonly diagnostics: UsrpB205WorkerDiagnostics;
  readonly observedSessionDetails: UsrpB205SessionDetails;
  initialize(serialNumber: string | null, image: VerifiedUsrpB205Image, firmware: VerifiedUsrpB205Firmware, requested: UsrpB205RequestedConfiguration): Promise<UsrpB205SessionDetails>;
  start(generation: number): Promise<void>;
  stopAndDrain(): Promise<void>;
  retune(centerFrequencyHz: number): Promise<UsrpB205SessionDetails>;
  close(): Promise<void>;
}

type Pending = {
  resolve(value: UsrpB205WorkerResponse): void;
  reject(error: unknown): void;
  timer: ReturnType<typeof setTimeout>;
};

const emptyDiagnostics = (): UsrpB205WorkerDiagnostics => ({ connection: null, configuration: null, receive: null });

/** Main-thread proxy for the sole USB owner. No USBDevice crosses this
 * boundary; bounded, owned USRP SC16 batches stay encoded until the existing
 * spectrum and channel workers normalize them. */
export class UsrpB205WorkerSession implements UsrpB205WorkerSessionPort {
  private readonly worker: UsrpB205WorkerPort;
  private readonly pending = new Map<number, Pending>();
  private nextId = 1;
  private closed = false;
  private details?: UsrpB205SessionDetails;
  private diagnosticsValue = emptyDiagnostics();

  constructor(
    private readonly events: UsrpB205WorkerSessionEvents,
    factory = (): UsrpB205WorkerPort => new Worker(
      new URL("../workers/usrp-b205-session.worker.ts", import.meta.url),
      { type: "module" },
    ),
  ) {
    this.worker = factory();
    this.worker.onmessage = (event: MessageEvent<UsrpB205WorkerResponse>) => this.receive(event.data);
    this.worker.onerror = () => this.fail(new Error("USRP B205-mini device worker failed."));
  }

  get diagnostics(): UsrpB205WorkerDiagnostics { return structuredClone(this.diagnosticsValue); }
  get observedSessionDetails(): UsrpB205SessionDetails {
    if (!this.details) throw new Error("USRP B205-mini worker is not configured.");
    return structuredClone(this.details);
  }

  async initialize(
    serialNumber: string | null,
    image: VerifiedUsrpB205Image,
    firmware: VerifiedUsrpB205Firmware,
    requested: UsrpB205RequestedConfiguration,
  ): Promise<UsrpB205SessionDetails> {
    const ownedBytes = Uint8Array.from(image.bytes);
    const response = await this.command({
      type: "initialize", serialNumber, image: { ...image, contract: { ...image.contract }, bytes: ownedBytes },
      firmware: { ...firmware, contract: { ...firmware.contract } }, requested,
    }, 60_000, [ownedBytes.buffer]);
    if (!response.details) throw new Error("USRP B205-mini worker omitted initialization evidence.");
    this.details = structuredClone(response.details);
    return structuredClone(response.details);
  }

  async start(generation: number): Promise<void> { await this.command({ type: "start", generation }, 10_000); }
  async stopAndDrain(): Promise<void> { if (!this.closed) await this.command({ type: "stop" }, 5_000); }
  async retune(centerFrequencyHz: number): Promise<UsrpB205SessionDetails> {
    const response = await this.command({ type: "retune", centerFrequencyHz }, 30_000);
    if (!response.details) throw new Error("USRP B205-mini worker omitted retune evidence.");
    this.details = structuredClone(response.details);
    return structuredClone(response.details);
  }
  async close(): Promise<void> {
    if (this.closed) return;
    try { await this.command({ type: "close" }, 7_000); }
    finally { this.closed = true; this.worker.terminate(); this.rejectPending(new DOMException("USRP B205-mini worker closed.", "AbortError")); }
  }

  private command(
    request: UsrpB205WorkerCommand,
    timeoutMs: number,
    transfer: Transferable[] = [],
  ): Promise<Extract<UsrpB205WorkerResponse, { type: "response" }>> {
    if (this.closed) return Promise.reject(new DOMException("USRP B205-mini worker is closed.", "InvalidStateError"));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new DOMException(`USRP B205-mini worker ${request.type} timed out.`, "TimeoutError"));
      }, timeoutMs);
      this.pending.set(id, { resolve: resolve as Pending["resolve"], reject, timer });
      try { this.worker.postMessage({ ...request, id } as UsrpB205WorkerRequest, transfer); }
      catch (error) { clearTimeout(timer); this.pending.delete(id); reject(error); }
    });
  }

  private receive(message: UsrpB205WorkerResponse): void {
    if (this.closed) return;
    if ("diagnostics" in message) this.diagnosticsValue = structuredClone(message.diagnostics);
    if (message.type === "response" || message.type === "response-error") {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      clearTimeout(pending.timer);
      if (message.type === "response-error") pending.reject(new Error(message.message));
      else pending.resolve(message);
      return;
    }
    if (message.type === "usrp-sc16-packets") {
      try {
        let payloadBytes = 0;
        for (const packet of message.packets) {
          if (packet.byteLength < 16 || (packet.byteLength - 16) % 4 !== 0)
            throw new Error("USRP B205-mini worker returned a malformed native packet.");
          payloadBytes += packet.byteLength - 16;
        }
        const bytes = new Uint8Array(payloadBytes);
        let offset = 0;
        for (const packet of message.packets) {
          const payload = new Uint8Array(packet, 16);
          bytes.set(payload, offset);
          offset += payload.byteLength;
        }
        this.events.usrpSc16(bytes, message.frequency, message.generation);
      } catch (error) {
        this.fail(error instanceof Error ? error : new Error(String(error)));
      } finally {
        this.worker.postMessage({ type: "sample-consumed", generation: message.generation });
      }
      return;
    }
    if (message.type === "discontinuity") { this.events.discontinuity(message.value); return; }
    if (message.type === "generation") {
      this.details = structuredClone(message.details);
      this.events.generationChanged(message.generation, message.reason, message.details);
      return;
    }
    this.fail(new Error(message.message));
  }

  private fail(error: Error): void {
    if (this.closed) return;
    this.rejectPending(error);
    this.events.error(error);
  }
  private rejectPending(error: unknown): void {
    for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(error); }
    this.pending.clear();
  }
}

export function createUsrpB205WorkerSession(events: UsrpB205WorkerSessionEvents): UsrpB205WorkerSessionPort {
  return new UsrpB205WorkerSession(events);
}

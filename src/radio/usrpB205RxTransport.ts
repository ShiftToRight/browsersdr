import {
  usrpB205RateProfile,
  type UsrpB205SampleRateHz,
  type UsrpB205SessionDetails,
} from "./usrpB205Capabilities";
import type { UsrpB205ClaimedBulkIo } from "./usrpB205Fx3";
import {
  USRP_B205_RX_TRANSFER_BYTES,
  UsrpB205RxAccumulator,
  decodeUsrpB205RxPacket,
  type UsrpB205RxDataPacket,
  type UsrpB205RxPacket,
} from "./usrpB205RxVrt";
export { USRP_B205_RX_TRANSFER_BYTES } from "./usrpB205RxVrt";

// Native UHD uses 16 receive frames. Physical 4.8 MS/s Chrome testing measured
// occasional ~140 ms browser/worker round trips: keep ~218 ms of submitted
// reads at 4.8 MS/s. Physical high-rate Chrome testing needs the separately
// bounded 768-read window: ~327 ms at 9.6 MS/s and ~164 ms at 19.2 MS/s.
export const USRP_B205_RX_READ_SLOTS = 256 as const;
export const USRP_B205_HIGH_RATE_RX_READ_SLOTS = 768 as const;
export const USRP_B205_RX_QUEUE_PACKETS = 1_536 as const;
export const USRP_B205_RX_QUEUE_BYTES = 25_128_960 as const;
export const USRP_B205_RX_WATCHDOG_MS = 2_000 as const;

export interface UsrpB205RxCommands {
  startContinuous(): Promise<void>;
  stopContinuous(): Promise<void>;
}

export interface UsrpB205Discontinuity {
  readonly generation: number;
  readonly missingSamples: number | null;
  readonly reason: string;
  readonly expectedSequence?: number;
  readonly actualSequence?: number;
}

export interface UsrpB205NativeBlock {
  /** Owned complete CHDR packet, retained through the synchronous capture callback. */
  readonly nativePacketBytes: Uint8Array;
  /** Borrowed payload view into nativePacketBytes. */
  readonly bytes: Uint8Array;
  readonly encoding: "chdr-vrt-sc16-le";
  readonly sampleWordOrder: "i16-msw-q16-lsw";
  readonly bytesPerComplexSample: 4;
  readonly complexSampleCount: number;
  readonly nativeSampleRateHz: UsrpB205SampleRateHz;
  readonly generation: number;
  readonly sequence: number;
  readonly timestampTicks: bigint;
  readonly firstSampleIndex: number;
  readonly receivedAtMonotonicMs: number;
  readonly endOfBurst: boolean;
  readonly discontinuityBefore: UsrpB205Discontinuity | null;
}

export interface UsrpB205RxTransportEvents {
  error?(error: unknown): void;
  discontinuity?(value: UsrpB205Discontinuity): void;
  generationChanged?(generation: number, reason: string, details: UsrpB205SessionDetails): void;
}

export interface UsrpB205RxTransportOptions {
  closeOwner(): Promise<void>;
  now?: () => number;
  stopTimeoutMs?: number;
  watchdogMs?: number;
}

interface QueuedPacket { packet: UsrpB205RxPacket; receivedAt: number }
interface CompletedRead { result?: USBInTransferResult; error?: unknown; receivedAt: number }

export interface UsrpB205RxTransportDiagnostics {
  readonly state: "configured" | "starting" | "running" | "recovering" | "stopping" | "error" | "cleanup-required" | "closed";
  readonly generation: number;
  readonly pendingReads: number;
  readonly pendingReadsHighWater: number;
  readonly completedReadBacklog: number;
  readonly packetQueueLength: number;
  readonly packetQueueBytes: number;
  readonly packetQueueHighWater: number;
  readonly parserBytes: number;
  readonly rawTransferBudgetBytes: number;
  readonly packetQueueBudgetBytes: number;
  readonly steadyStateBudgetBytes: number;
  readonly packetsReceived: number;
  readonly samplesDelivered: number;
  readonly lastSequence: number | null;
  readonly lastTimestampTicks: bigint | null;
  readonly timestampRateValidation: "pending" | "observed";
  readonly discontinuityCount: number;
  readonly overflowRestarts: number;
  readonly watchdogRestarts: number;
  readonly rxHaltClears: number;
  readonly diagnosticRecords: readonly UsrpB205RxDiagnosticRecord[];
}

export interface UsrpB205RxDiagnosticRecord {
  readonly at: number;
  readonly kind: string;
  readonly message: string;
  readonly snippet: readonly number[];
}

const abortError = () => new DOMException("USRP B205-mini receive generation was cancelled.", "AbortError");
const timeoutError = () => new DOMException("USRP B205-mini pending RX reads did not settle within 2 seconds.", "TimeoutError");

export class UsrpB205RxTransport {
  private stateValue: UsrpB205RxTransportDiagnostics["state"] = "configured";
  private session: UsrpB205SessionDetails;
  private generation = 0;
  private lastStartedGeneration = -1;
  private token = 0;
  private callback?: (block: UsrpB205NativeBlock) => void;
  private readonly parser = new UsrpB205RxAccumulator();
  private readonly reads = new Set<Promise<void>>();
  private readonly completed = new Map<number, CompletedRead>();
  private nextSubmission = 0;
  private nextCompletion = 0;
  private pendingReadsHighWater = 0;
  private readonly packets: QueuedPacket[] = [];
  private packetBytes = 0;
  private packetHighWater = 0;
  private drainScheduled = false;
  private expectedSequence: number | null = null;
  private expectedTimestamp: bigint | null = null;
  private sampleIndex = 0;
  private pendingDiscontinuity: UsrpB205Discontinuity | null = null;
  private lastFullPacket: { sequence: number; timestamp: bigint } | null = null;
  private timestampRateValidation: "pending" | "observed" = "pending";
  private packetsReceived = 0;
  private samplesDelivered = 0;
  private lastSequence: number | null = null;
  private lastTimestamp: bigint | null = null;
  private discontinuityCount = 0;
  private overflowRestarts = 0;
  private watchdogRestarts = 0;
  private rxHaltClears = 0;
  private readonly overflowTimes: number[] = [];
  private readonly watchdogTimes: number[] = [];
  private lastOverflowRestart = -Infinity;
  private watchdog: ReturnType<typeof setTimeout> | undefined;
  private stopTask?: Promise<void>;
  private closeTask?: Promise<void>;
  private recoveryTask?: Promise<void>;
  private fatalStarted = false;
  private readonly diagnosticRing: UsrpB205RxDiagnosticRecord[] = [];

  private get rateProfile() { return usrpB205RateProfile(this.session.nativeSampleRateHz); }
  private get readSlots(): number {
    return this.session.nativeSampleRateHz >= 9_600_000
      ? USRP_B205_HIGH_RATE_RX_READ_SLOTS
      : USRP_B205_RX_READ_SLOTS;
  }

  constructor(
    private readonly io: UsrpB205ClaimedBulkIo,
    private readonly commands: UsrpB205RxCommands,
    session: UsrpB205SessionDetails,
    private readonly events: UsrpB205RxTransportEvents,
    private readonly options: UsrpB205RxTransportOptions,
  ) { this.session = structuredClone(session); }

  get diagnostics(): UsrpB205RxTransportDiagnostics {
    return {
      state: this.stateValue, generation: this.generation, pendingReads: this.reads.size,
      pendingReadsHighWater: this.pendingReadsHighWater, completedReadBacklog: this.completed.size,
      packetQueueLength: this.packets.length, packetQueueBytes: this.packetBytes,
      packetQueueHighWater: this.packetHighWater, parserBytes: this.parser.retainedByteLength,
      rawTransferBudgetBytes: this.readSlots * USRP_B205_RX_TRANSFER_BYTES,
      packetQueueBudgetBytes: USRP_B205_RX_QUEUE_BYTES, steadyStateBudgetBytes: 64 * 1024 * 1024,
      packetsReceived: this.packetsReceived, samplesDelivered: this.samplesDelivered,
      lastSequence: this.lastSequence, lastTimestampTicks: this.lastTimestamp,
      timestampRateValidation: this.timestampRateValidation, discontinuityCount: this.discontinuityCount,
      overflowRestarts: this.overflowRestarts, watchdogRestarts: this.watchdogRestarts,
      rxHaltClears: this.rxHaltClears,
      diagnosticRecords: this.diagnosticRing.map((entry) => ({ ...entry, snippet: [...entry.snippet] })),
    };
  }

  get observedSessionDetails(): UsrpB205SessionDetails {
    return structuredClone(this.session);
  }

  updateSession(session: UsrpB205SessionDetails): void {
    if (!["configured", "recovering"].includes(this.stateValue)) throw new DOMException("Stop USRP B205-mini RX before replacing session metadata.", "InvalidStateError");
    const next = structuredClone(session);
    if (this.timestampRateValidation === "observed") {
      next.observations.timestampRateValidation = "observed";
    }
    this.session = next;
  }

  async start(generation: number, callback: (block: UsrpB205NativeBlock) => void): Promise<void> {
    if (this.stateValue !== "configured" || generation <= this.lastStartedGeneration) {
      throw new DOMException("USRP B205-mini RX start requires a fresh configured generation.", "InvalidStateError");
    }
    this.generation = generation;
    this.lastStartedGeneration = generation;
    this.callback = callback;
    await this.startCurrentGeneration();
  }

  private async startCurrentGeneration(): Promise<void> {
    const token = ++this.token;
    this.stateValue = "starting";
    this.resetStreamState();
    for (let slot = 0; slot < this.readSlots; slot += 1) this.submitRead(token);
    try {
      await this.commands.startContinuous();
      if (token !== this.token || this.stateValue !== "starting") throw abortError();
      // Reads are deliberately queued before START_CONTINUOUS so the FX3 never
      // begins with an empty host window. A restarted stream can still have
      // stopped-generation bytes in the endpoint FIFO; completions received
      // while the start acknowledgement was outstanding were parsed only into
      // this private queue. Drop them at the acknowledged generation boundary.
      this.parser.reset();
      this.packets.splice(0);
      this.packetBytes = 0;
      this.drainScheduled = false;
      this.stateValue = "running";
      this.armWatchdog(token);
      this.schedulePacketDrain(token);
    } catch (error) {
      if (token === this.token) await this.fail(error);
      throw error;
    }
  }

  private submitRead(token: number): void {
    if (token !== this.token || !["starting", "running"].includes(this.stateValue)) return;
    const submission = this.nextSubmission++;
    const task: Promise<void> = this.io.transferRxIn(USRP_B205_RX_TRANSFER_BYTES).then(
      (result) => { this.reads.delete(task); this.completeRead(token, submission, { result, receivedAt: this.now() }); },
      (error: unknown) => { this.reads.delete(task); this.completeRead(token, submission, { error, receivedAt: this.now() }); },
    );
    this.reads.add(task);
    this.pendingReadsHighWater = Math.max(this.pendingReadsHighWater, this.reads.size);
  }

  private completeRead(token: number, submission: number, completed: CompletedRead): void {
    if (token !== this.token || !["starting", "running"].includes(this.stateValue)) return;
    this.completed.set(submission, completed);
    // Promise completion order is not USB byte-stream order. Replenish the
    // hardware queue immediately, then consume from `completed` by submission
    // number. Waiting to replenish until the oldest Promise resolves drains
    // every host request when Chrome reports a later transfer first.
    this.submitRead(token);
    if (this.completed.size > this.readSlots * 2) {
      void this.fail(new DOMException("USRP B205-mini out-of-order RX completion backlog exceeded its bound.", "NetworkError"));
      return;
    }
    this.drainCompleted(token);
  }

  private drainCompleted(token: number): void {
    while (this.completed.has(this.nextCompletion) && token === this.token
      && ["starting", "running"].includes(this.stateValue)) {
      const completed = this.completed.get(this.nextCompletion)!;
      this.completed.delete(this.nextCompletion++);
      if (completed.error) { void this.fail(completed.error); return; }
      const result = completed.result!;
      const view = result.data;
      if (result.status === "stall") { void this.recover("RX endpoint stalled", true); return; }
      if (result.status !== "ok" || !view || view.byteLength === 0 || view.byteLength > USRP_B205_RX_TRANSFER_BYTES) {
        void this.fail(new DOMException(`USRP B205-mini endpoint 6 returned ${result.status} with ${view?.byteLength ?? 0} bytes.`, "NetworkError"));
        return;
      }
      try {
        const source = new Uint8Array(view.buffer, view.byteOffset, view.byteLength);
        for (const bytes of this.parser.push(source)) {
          this.enqueuePacket(decodeUsrpB205RxPacket(bytes), completed.receivedAt, token);
          if (token !== this.token) return;
        }
      } catch (error) { void this.fail(error); return; }
      this.armWatchdog(token);
    }
  }

  private enqueuePacket(packet: UsrpB205RxPacket, receivedAt: number, token: number): void {
    const nextBytes = this.packetBytes + packet.packetBytes.byteLength;
    if (this.packets.length >= USRP_B205_RX_QUEUE_PACKETS || nextBytes > USRP_B205_RX_QUEUE_BYTES) {
      this.packets.splice(0);
      this.packetBytes = 0;
      this.parser.reset();
      this.markDiscontinuity(null, "USRP B205-mini native packet queue overrun");
      void this.recover("host packet queue overrun", false);
      return;
    }
    this.packets.push({ packet, receivedAt });
    this.packetBytes = nextBytes;
    this.packetHighWater = Math.max(this.packetHighWater, this.packetBytes);
    this.schedulePacketDrain(token);
  }

  private schedulePacketDrain(token: number): void {
    if (this.drainScheduled) return;
    this.drainScheduled = true;
    queueMicrotask(() => {
      this.drainScheduled = false;
      if (token !== this.token || this.stateValue !== "running") return;
      while (this.packets.length && token === this.token && this.stateValue === "running") {
        const queued = this.packets.shift()!;
        this.packetBytes -= queued.packet.packetBytes.byteLength;
        try { this.consumePacket(queued.packet, queued.receivedAt); }
        catch (error) { void this.fail(error); return; }
      }
    });
  }

  private consumePacket(packet: UsrpB205RxPacket, receivedAt: number): void {
    this.packetsReceived++;
    this.lastSequence = packet.sequence;
    this.lastTimestamp = packet.timestampTicks;
    if (packet.kind === "inline") {
      if (this.expectedSequence === null) this.expectedSequence = packet.sequence;
      else if (packet.sequence !== this.expectedSequence) {
        this.markDiscontinuity(null, "VRT inline sequence mismatch", this.expectedSequence, packet.sequence);
        this.expectedSequence = packet.sequence;
      }
      if (packet.code === 0x8) {
        this.markDiscontinuity(null, "FPGA RX overflow", this.expectedSequence, packet.sequence);
        this.record("inline-overflow", "FPGA RX overflow", packet.packetBytes);
        void this.handleOverflow();
        return;
      }
      const names = new Map([[0x4, "broken chain"], [0x2, "late command"], [0xd, "zero-length command"]]);
      const name = names.get(packet.code) ?? `unknown code 0x${packet.code.toString(16)}`;
      throw new Error(`USRP B205-mini fatal inline message: ${name}.`);
    }
    this.consumeData(packet, receivedAt);
  }

  private consumeData(packet: UsrpB205RxDataPacket, receivedAt: number): void {
    let discontinuity = false;
    const reasons: string[] = [];
    if (this.expectedSequence !== null && packet.sequence !== this.expectedSequence) {
      discontinuity = true;
      reasons.push("VRT data sequence mismatch");
    }
    if (this.expectedTimestamp !== null && packet.timestampTicks !== this.expectedTimestamp) {
      discontinuity = true;
      reasons.push("VRT timestamp discontinuity");
    }
    if (discontinuity) {
      const missing = this.provenMissingSamples(packet.timestampTicks);
      this.markDiscontinuity(missing, reasons.join(" and "), this.expectedSequence ?? undefined, packet.sequence);
      this.lastFullPacket = null;
    } else if (this.lastFullPacket && packet.complexSampleCount === 4086
      && this.lastFullPacket.sequence === ((packet.sequence - 1) & 0xfff)
      && packet.timestampTicks - this.lastFullPacket.timestamp
        === BigInt(4086 * this.rateProfile.timestampTicksPerSample)) {
      this.timestampRateValidation = "observed";
      this.session = { ...this.session, observations: { ...this.session.observations, timestampRateValidation: "observed" } };
    }
    if (this.pendingDiscontinuity?.missingSamples !== null) this.sampleIndex += this.pendingDiscontinuity?.missingSamples ?? 0;
    const firstSampleIndex = this.sampleIndex;
    this.expectedSequence = (packet.sequence + 1) & 0xfff;
    this.expectedTimestamp = packet.timestampTicks
      + BigInt(packet.complexSampleCount * this.rateProfile.timestampTicksPerSample);
    this.lastFullPacket = packet.complexSampleCount === 4086 ? { sequence: packet.sequence, timestamp: packet.timestampTicks } : null;
    const block: UsrpB205NativeBlock = {
      nativePacketBytes: packet.packetBytes, bytes: packet.payloadBytes,
      encoding: "chdr-vrt-sc16-le", sampleWordOrder: "i16-msw-q16-lsw", bytesPerComplexSample: 4,
      complexSampleCount: packet.complexSampleCount, nativeSampleRateHz: this.rateProfile.sampleRateHz,
      generation: this.generation, sequence: packet.sequence, timestampTicks: packet.timestampTicks,
      firstSampleIndex, receivedAtMonotonicMs: receivedAt, endOfBurst: packet.endOfBurst,
      discontinuityBefore: this.pendingDiscontinuity,
    };
    this.pendingDiscontinuity = null;
    this.callSync(this.callback, block);
    this.sampleIndex += packet.complexSampleCount;
    this.samplesDelivered += packet.complexSampleCount;
    if (packet.endOfBurst) {
      this.markDiscontinuity(0, "VRT end-of-burst boundary");
      this.expectedSequence = null;
      this.expectedTimestamp = null;
      this.lastFullPacket = null;
    }
  }

  private provenMissingSamples(actualTimestamp: bigint): number | null {
    if (this.expectedTimestamp === null) return null;
    const ticks = actualTimestamp - this.expectedTimestamp;
    const ticksPerSample = BigInt(this.rateProfile.timestampTicksPerSample);
    if (ticks < 0n || ticks % ticksPerSample !== 0n) return null;
    const samples = ticks / ticksPerSample;
    return samples <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(samples) : null;
  }

  private markDiscontinuity(missingSamples: number | null, reason: string, expectedSequence?: number, actualSequence?: number): void {
    const combinedMissing = this.pendingDiscontinuity
      ? (this.pendingDiscontinuity.missingSamples === null || missingSamples === null
        ? null : this.pendingDiscontinuity.missingSamples + missingSamples)
      : missingSamples;
    const combinedReason = this.pendingDiscontinuity ? `${this.pendingDiscontinuity.reason}; ${reason}` : reason;
    const value: UsrpB205Discontinuity = { generation: this.generation, missingSamples: combinedMissing, reason: combinedReason,
      ...(expectedSequence === undefined ? {} : { expectedSequence }), ...(actualSequence === undefined ? {} : { actualSequence }) };
    this.pendingDiscontinuity = value;
    this.discontinuityCount++;
    try { this.events.discontinuity?.(value); } catch { /* Diagnostic observer only. */ }
    this.record("discontinuity", reason);
  }

  private async handleOverflow(): Promise<void> {
    const now = this.now();
    this.overflowTimes.push(now);
    while (this.overflowTimes[0] !== undefined && now - this.overflowTimes[0] > 30_000) this.overflowTimes.shift();
    if (this.overflowTimes.length >= 3) { await this.fail(new Error("USRP B205-mini received three RX overflows within 30 seconds.")); return; }
    if (now - this.lastOverflowRestart < 5_000) return;
    this.lastOverflowRestart = now;
    this.overflowRestarts++;
    await this.restartAfterOverflow();
  }

  /**
   * Match UHD's one-channel B200/B205 overflow path: The receive framer is
   * already in continuous mode, so reissue START_CONTINUOUS without stopping
   * the stream or draining the USB transport. WebUSB transferIn promises are
   * not cancellable; stopping first leaves the outstanding endpoint-6 reads
   * pending forever and turns a recoverable FPGA overflow into a close.
   */
  private restartAfterOverflow(): Promise<void> {
    if (this.recoveryTask) return this.recoveryTask;
    if (this.stateValue !== "running") return Promise.resolve();
    const token = this.token;
    const task = (async () => {
      try {
        await this.commands.startContinuous();
        if (token !== this.token || this.stateValue !== "running") return;
        this.generation++;
        this.lastStartedGeneration = this.generation;
        this.expectedSequence = null;
        this.expectedTimestamp = null;
        this.lastFullPacket = null;
        this.sampleIndex = 0;
        try { this.events.generationChanged?.(this.generation, "FPGA RX overflow", this.observedSessionDetails); }
        catch { /* Observer cannot break recovery. */ }
        this.armWatchdog(token);
      } catch (error) { await this.fail(error); }
    })().finally(() => { if (this.recoveryTask === task) this.recoveryTask = undefined; });
    this.recoveryTask = task;
    return task;
  }

  private async handleWatchdog(): Promise<void> {
    const now = this.now();
    this.watchdogTimes.push(now);
    while (this.watchdogTimes[0] !== undefined && now - this.watchdogTimes[0] > 30_000)
      this.watchdogTimes.shift();
    if (this.watchdogTimes.length >= 3) {
      await this.fail(new DOMException(
        "USRP B205-mini endpoint 6 made no progress after three bounded receive restarts within 30 seconds.",
        "TimeoutError",
      ));
      return;
    }
    this.markDiscontinuity(null, "USRP B205-mini endpoint 6 made no progress for 2 seconds");
    this.watchdogRestarts++;
    await this.restartAfterWatchdog();
  }

  /** Outstanding WebUSB reads cannot be cancelled safely here. Reissue only
   * the approved RX START_CONTINUOUS command, invalidate the delivery
   * generation, and retain the pending endpoint window. */
  private restartAfterWatchdog(): Promise<void> {
    if (this.recoveryTask) return this.recoveryTask;
    if (this.stateValue !== "running") return Promise.resolve();
    const token = this.token;
    const task = (async () => {
      try {
        await this.commands.startContinuous();
        if (token !== this.token || this.stateValue !== "running") return;
        this.generation++;
        this.lastStartedGeneration = this.generation;
        this.expectedSequence = null;
        this.expectedTimestamp = null;
        this.lastFullPacket = null;
        this.sampleIndex = 0;
        try {
          this.events.generationChanged?.(
            this.generation,
            "endpoint no-progress receive restart",
            this.observedSessionDetails,
          );
        } catch { /* Observer cannot break recovery. */ }
        this.armWatchdog(token);
      } catch (error) { await this.fail(error); }
    })().finally(() => { if (this.recoveryTask === task) this.recoveryTask = undefined; });
    this.recoveryTask = task;
    return task;
  }

  private recover(reason: string, clearHalt: boolean): Promise<void> {
    if (this.recoveryTask) return this.recoveryTask;
    if (this.stateValue !== "running") return Promise.resolve();
    const task = (async () => {
      this.stateValue = "recovering";
      ++this.token;
      this.clearWatchdog();
      this.clearQueuedState();
      try {
        await this.commands.stopContinuous();
        if (!await this.settleReads()) throw timeoutError();
        if (clearHalt) { await this.io.clearRxHalt(); this.rxHaltClears++; }
        this.generation++;
        this.lastStartedGeneration = this.generation;
        try { this.events.generationChanged?.(this.generation, reason, this.observedSessionDetails); } catch { /* Observer cannot break recovery. */ }
        this.stateValue = "configured";
        await this.startCurrentGeneration();
      } catch (error) { await this.fail(error); }
    })().finally(() => { if (this.recoveryTask === task) this.recoveryTask = undefined; });
    this.recoveryTask = task;
    return task;
  }

  stop(preserveCallback = false): Promise<void> {
    if (this.stopTask) return this.stopTask;
    if (!["starting", "running", "recovering"].includes(this.stateValue)) return Promise.resolve();
    const task = (async () => {
      let ownerCloseAttempted = false;
      this.stateValue = "stopping";
      ++this.token;
      if (!preserveCallback) this.callback = undefined;
      this.clearWatchdog();
      this.clearQueuedState();
      try {
        // WebUSB transferIn promises cannot be cancelled. After invalidating
        // delivery and replenishment, drain the finite submitted window while
        // RX is still producing bytes; stopping the FPGA first can strand the
        // tail of a large high-rate window forever.
        const drained = await this.settleReads();
        await this.commands.stopContinuous();
        if (!drained) {
          ownerCloseAttempted = true;
          await this.closeOwner();
          throw timeoutError();
        }
        this.stateValue = "configured";
        if (!preserveCallback) {
          ownerCloseAttempted = true;
          await this.closeOwner();
        }
      } catch (error) {
        if (!ownerCloseAttempted) await this.closeOwner();
        throw error;
      }
    })().finally(() => { if (this.stopTask === task) this.stopTask = undefined; });
    this.stopTask = task;
    return task;
  }

  close(): Promise<void> {
    if (this.closeTask) return this.closeTask;
    const task = (async () => {
      if (["starting", "running", "recovering"].includes(this.stateValue)) {
        await this.stop();
        return;
      }
      ++this.token;
      this.callback = undefined;
      this.clearWatchdog();
      this.clearQueuedState();
      await this.closeOwner();
    })().finally(() => { if (this.closeTask === task) this.closeTask = undefined; });
    this.closeTask = task;
    return task;
  }

  async stopAndDrain(): Promise<void> { await this.stop(true); }
  incrementGenerationAndDiscardOldPackets(): void {
    if (this.stateValue !== "configured") throw new DOMException("USRP B205-mini retune generation requires a stopped transport.", "InvalidStateError");
    this.generation++;
    this.clearQueuedState();
  }
  acceptSession(details: UsrpB205SessionDetails): void {
    this.updateSession(details);
    try { this.events.generationChanged?.(this.generation, "retune", this.observedSessionDetails); } catch { /* Observer cannot break the boundary. */ }
  }
  resetExpectedRxSequence(): void { this.resetContinuity(); }
  async restart(): Promise<void> {
    if (this.stateValue !== "configured" || !this.callback) throw new DOMException("USRP B205-mini retune restart has no configured callback.", "InvalidStateError");
    this.lastStartedGeneration = this.generation;
    await this.startCurrentGeneration();
  }

  private async settleReads(): Promise<boolean> {
    const pending = [...this.reads];
    if (!pending.length) return true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<false>((resolve) => { timer = setTimeout(() => resolve(false), this.options.stopTimeoutMs ?? 2_000); });
    const settled = Promise.allSettled(pending).then(() => true as const);
    const result = await Promise.race([settled, timeout]);
    if (timer) clearTimeout(timer);
    return result;
  }

  private async fail(error: unknown): Promise<void> {
    if (this.fatalStarted || ["closed", "cleanup-required"].includes(this.stateValue)) return;
    this.fatalStarted = true;
    ++this.token;
    this.callback = undefined;
    this.clearWatchdog();
    this.clearQueuedState();
    this.stateValue = "error";
    this.markDiscontinuity(null, error instanceof Error ? error.message : "USRP B205-mini RX failure");
    try { this.events.error?.(error); } catch { /* Diagnostic observer only. */ }
    try { await this.closeOwner(); } catch { /* Retryable cleanup-required state is retained. */ }
  }

  private async closeOwner(): Promise<void> {
    try { await this.options.closeOwner(); this.stateValue = "closed"; }
    catch (error) { this.stateValue = "cleanup-required"; throw error; }
  }

  private resetStreamState(): void {
    this.nextSubmission = 0;
    this.nextCompletion = 0;
    this.completed.clear();
    this.clearQueuedState();
    this.resetContinuity();
    this.sampleIndex = 0;
    // An explicit start/restart is a clean acquisition boundary. Keep the
    // three-in-30-seconds guard scoped to automatic overflow recovery within
    // that acquisition, not across user Stop/Start or a serialized retune.
    this.overflowTimes.splice(0);
    this.watchdogTimes.splice(0);
    this.lastOverflowRestart = -Infinity;
  }

  private resetContinuity(): void {
    this.expectedSequence = null;
    this.expectedTimestamp = null;
    this.lastFullPacket = null;
    this.pendingDiscontinuity = null;
  }

  private clearQueuedState(): void {
    this.parser.reset();
    this.packets.splice(0);
    this.packetBytes = 0;
    this.completed.clear();
    this.drainScheduled = false;
  }

  private armWatchdog(token: number): void {
    this.clearWatchdog();
    this.watchdog = setTimeout(() => {
      if (token === this.token && this.stateValue === "running") void this.handleWatchdog();
    }, this.options.watchdogMs ?? USRP_B205_RX_WATCHDOG_MS);
  }
  private clearWatchdog(): void { if (this.watchdog) clearTimeout(this.watchdog); this.watchdog = undefined; }

  private callSync<T>(callback: ((value: T) => void) | undefined, value: T): void {
    const returned: unknown = callback?.(value);
    if (returned && typeof (returned as PromiseLike<unknown>).then === "function") {
      void Promise.resolve(returned).catch(() => undefined);
      throw new Error("USRP B205-mini sample callbacks must copy or consume synchronously.");
    }
  }

  private record(kind: string, message: string, bytes?: Uint8Array): void {
    this.diagnosticRing.push({ at: this.now(), kind, message, snippet: bytes ? [...bytes.subarray(0, 64)] : [] });
    if (this.diagnosticRing.length > 256) this.diagnosticRing.shift();
  }
  private now(): number { return this.options.now?.() ?? performance.now(); }
}

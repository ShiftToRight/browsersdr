import { IngressTimings, type IngressDiagnostics } from "./ingressTimings";
import {
  HACKRF_DEADLINE_MS,
  HACKRF_USB_FILTER,
  HackrfProtocol,
  validateHackrfConfiguration,
  type HackrfConfiguration,
  type HackrfConfiguredSession,
} from "./hackrfProtocol";
import { isStableHackrfApi, type HackrfIdentity } from "./sourceCapabilities";

export const HACKRF_READ_SLOTS = 4;
/** Keep WebUSB request fan-out bounded independently of the channel backlog.
 * Sixty-four 64 KiB requests retain about 109 ms even at 19.2 MS/s. The much
 * deeper channel-worker pool absorbs main-thread/DAB scheduling stalls after
 * each completed native block has been copied out of its USB transfer. */
export const HACKRF_WIDEBAND_READ_SLOTS = 64;
export const HACKRF_READ_BYTES = 65_536;
export const HACKRF_MAX_COMPLEX_SAMPLES = HACKRF_READ_BYTES / 2;
const RECLAIM_DELAYS_MS = [100, 250] as const;
export interface NativeIqBlock {
  bytes: Uint8Array;
  encoding: "ci8";
  sampleOrder: "interleaved-iq";
  bytesPerComplexSample: 2;
  complexSampleCount: number;
  nativeSampleRateHz: number;
  generation: number;
  sequence: number;
  firstSampleIndex: number;
  receivedAtMonotonicMs: number;
  discontinuityBefore: { missingSamples: number | null; reason: string } | null;
}
export interface HackrfTransportEvents {
  error?(error: unknown): void;
  cleanupWarning?(): void;
}
export interface HackrfTransportDiagnostics {
  state:
    | "idle"
    | "open"
    | "configured"
    | "starting"
    | "running"
    | "closing"
    | "cleanup-required"
    | "closed";
  pendingOperations: number;
  readSlots: number;
  readSlotsHighWater: number;
  rawSlotBytesLimit: number;
  discardedSettlingSamples: number;
  discardedPartialPairs: number;
  knownHardwareLoss: null;
  ingress?: IngressDiagnostics;
  lastOffError?: string;
  lastDiscontinuity?: {
    generation: number;
    missingSamples: null;
    reason: string;
  };
}
const aborted = () =>
  new DOMException("HackRF acquisition was cancelled", "AbortError");
const stateError = (message: string) =>
  new DOMException(message, "InvalidStateError");
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  // A stream may fail before startRx reaches its await.
  void promise.catch(() => undefined);
  return { promise, resolve, reject };
}

/** One device owner. Commands reject while busy rather than growing a command queue.
 * stop/close interrupt commands; outstanding browser operations stay owned until settled. */
export class HackrfTransport {
  private device?: USBDevice;
  private identity?: HackrfIdentity;
  private config?: HackrfConfiguration;
  private session?: HackrfConfiguredSession;
  private token = 0;
  private busy = false;
  private terminal = false;
  private trustedIdentity = false;
  private needsClose = false;
  private cleanupTask?: Promise<void>;
  private acquisitions = new Set<Promise<unknown>>();
  private operations = new Set<Promise<unknown>>();
  private control?: Promise<unknown>;
  private controlDeadline = 0;
  private stopVersion = 0;
  private streamTask?: Promise<void>;
  private streaming = false;
  private ready?: ReturnType<typeof deferred<HackrfConfiguredSession>>;
  private verifiedRx = false;
  private carry?: number;
  private readonly pairs = new Uint8Array(HACKRF_READ_BYTES);
  private sequence = 0;
  private sampleIndex = 0;
  private startTime = 0;
  private settledSamples = 0;
  private errorReported = false;
  private consumerDebtMs = 0;
  private consumerBudgetMs = 0;
  private readonly timings = new IngressTimings([
    "USB pair assembly",
    "USB callback",
  ]);
  private lastGeneration = -1;
  private diag: HackrfTransportDiagnostics = {
    state: "idle",
    pendingOperations: 0,
    readSlots: 0,
    readSlotsHighWater: 0,
    rawSlotBytesLimit: HACKRF_READ_SLOTS * HACKRF_READ_BYTES,
    discardedSettlingSamples: 0,
    discardedPartialPairs: 0,
    knownHardwareLoss: null,
  };
  constructor(
    private readonly events: HackrfTransportEvents = {},
    private readonly now: () => number = () => performance.now(),
  ) {}

  get diagnostics(): Readonly<HackrfTransportDiagnostics> {
    return {
      ...this.diag,
      pendingOperations: this.operations.size,
      ingress: {
        stages: this.timings.snapshot(),
        debtMs: this.consumerDebtMs,
        budgetMs: this.consumerBudgetMs,
      },
    };
  }
  private guard(token: number): void {
    if (token !== this.token || this.terminal || this.cleanupTask)
      throw aborted();
  }
  private track<T>(promise: Promise<T>, acquisition = false): Promise<T> {
    this.operations.add(promise);
    if (acquisition) this.acquisitions.add(promise);
    const remove = () => {
      this.operations.delete(promise);
      this.acquisitions.delete(promise);
    };
    void promise.then(remove, remove);
    return promise;
  }
  private deadline<T>(
    promise: Promise<T>,
    ms = HACKRF_DEADLINE_MS,
  ): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.control === promise) this.controlDeadline = -Infinity;
        reject(
          new Error("HackRF operation made no progress before its deadline."),
        );
      }, ms);
      void promise.then(
        (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        (error: unknown) => {
          clearTimeout(timer);
          reject(error);
        },
      );
    });
  }
  private async command<T>(body: (token: number) => Promise<T>): Promise<T> {
    if (
      this.busy ||
      this.cleanupTask ||
      this.diag.state === "cleanup-required" ||
      this.terminal
    )
      throw stateError(
        "HackRF is busy or still owns resources requiring cleanup.",
      );
    this.busy = true;
    const token = ++this.token;
    try {
      return await body(token);
    } catch (error) {
      // Cleanup never waits for this command, only actual browser operations.
      try {
        await this.shutdown();
      } catch {
        /* Retain ownership; caller may retry close. */
      }
      throw error;
    } finally {
      this.busy = false;
    }
  }

  /** Invokes the chooser synchronously, before the first await, preserving activation. */
  requestAndOpen(
    usb: USB | undefined = navigator.usb,
  ): Promise<HackrfIdentity> {
    if (!usb)
      return Promise.reject(
        new Error(
          "WebUSB is unavailable; use HTTPS/localhost in a compatible browser.",
        ),
      );
    if (this.device || this.busy || this.terminal || this.cleanupTask)
      return Promise.reject(
        stateError("HackRF already has an acquisition owner."),
      );
    return this.command(async (token) => {
      const permission = this.track(
        usb
          .requestDevice({ filters: [{ ...HACKRF_USB_FILTER }] })
          .then((device) => {
            this.device = device;
            this.needsClose = true;
            return device;
          })
          .catch((error: unknown) => {
            if (
              error instanceof Error &&
              ["NotAllowedError", "SecurityError"].includes(error.name)
            )
              throw new Error(
                "HackRF USB access denied. Allow USB access for this site in a compatible browser using HTTPS or localhost, then reconnect.",
                { cause: error },
              );
            throw error;
          }),
        true,
      );
      const device = await permission;
      this.guard(token);
      return this.openOwned(device, token);
    });
  }
  open(device: USBDevice): Promise<HackrfIdentity> {
    if (this.device && this.device !== device)
      return Promise.reject(
        stateError("A different HackRF device is still owned."),
      );
    if (this.diag.state !== "idle")
      return Promise.reject(
        stateError(
          "HackRF must be closed/stopped before opening again through configure.",
        ),
      );
    return this.command(async (token) => {
      this.device = device;
      this.needsClose = true;
      return this.openOwned(device, token);
    });
  }
  private async openOwned(
    device: USBDevice,
    token: number,
    reclaim = false,
  ): Promise<HackrfIdentity> {
    this.guard(token);
    if (
      device.vendorId !== HACKRF_USB_FILTER.vendorId ||
      device.productId !== HACKRF_USB_FILTER.productId
    )
      throw new Error("Device is not in the verified HackRF USB filter.");
    this.needsClose = true;
    // Track open separately: a late success must be closed after it actually opens.
    if (!device.opened) await this.deadline(this.track(device.open(), true));
    this.guard(token);
    if (device.configuration?.configurationValue !== 1)
      await this.deadline(this.track(device.selectConfiguration(1)));
    this.guard(token);
    for (let attempt = 0; ; attempt++) {
      this.guard(token);
      try {
        await this.deadline(this.track(device.claimInterface(0)));
        break;
      } catch (error) {
        // A self-owned close/reopen can briefly fail to reclaim on Linux/Chrome.
        // Only our own reconfiguration handoff gets a bounded retry; initial access,
        // permission failures and persistent contention still fail normally.
        if (
          !reclaim ||
          !(error instanceof DOMException) ||
          error.name !== "NetworkError" ||
          attempt >= RECLAIM_DELAYS_MS.length
        )
          throw error;
        await new Promise<void>((resolve) =>
          setTimeout(resolve, RECLAIM_DELAYS_MS[attempt]),
        );
        this.guard(token);
      }
    }
    this.guard(token);
    const identity = await this.protocol(token).identify(device);
    this.guard(token);
    this.identity = identity;
    this.trustedIdentity = true;
    this.diag.state = "open";
    return structuredClone(identity);
  }
  configure(request: HackrfConfiguration): Promise<HackrfConfiguredSession> {
    // Validation must not disturb a running valid generation.
    let config: HackrfConfiguration;
    try {
      config = validateHackrfConfiguration(request);
      if (config.generation <= this.lastGeneration)
        throw new Error(
          "HackRF configuration requires a fresh acquisition generation.",
        );
    } catch (error) {
      return Promise.reject(error);
    }
    if (!this.device)
      return Promise.reject(stateError("Open a HackRF before configuring it."));
    const stopVersion = this.stopVersion;
    return this.command(async (initialToken) => {
      let token = initialToken;
      if (this.config || !this.device!.opened) {
        await this.shutdown();
        // shutdown invalidated old callbacks. This command is the sole reopen owner.
        if (this.terminal || stopVersion !== this.stopVersion) throw aborted();
        token = ++this.token;
        await this.openOwned(this.device!, token, true);
      }
      this.guard(token);
      const session = await this.protocol(token).configure(
        this.identity!,
        config,
      );
      this.guard(token);
      this.config = config;
      this.session = session;
      this.lastGeneration = config.generation;
      this.diag.state = "configured";
      return structuredClone(session);
    });
  }
  startRx(
    onBlock: (block: NativeIqBlock) => void,
    onReady?: (session: HackrfConfiguredSession) => void,
  ): Promise<HackrfConfiguredSession> {
    if (!this.config || !this.session || this.diag.state !== "configured")
      return Promise.reject(stateError("Configure HackRF before starting RX."));
    return this.command(async (token) => {
      this.errorReported = false;
      this.verifiedRx = false;
      this.consumerDebtMs = 0;
      this.timings.reset();
      this.ready = deferred<HackrfConfiguredSession>();
      await this.output(token, 1, 1, 0);
      this.guard(token);
      this.startTime = this.now();
      this.settledSamples = 0;
      this.sampleIndex = 0;
      this.sequence = 0;
      this.streaming = true;
      this.diag.state = "starting";
      this.streamTask = this.pump(token, onBlock, onReady);
      // Catch now; shutdown must not await a pump awaiting its own cleanup.
      void this.streamTask.catch((error: unknown) =>
        this.streamFailed(error, token),
      );
      this.session = await this.protocol(token).verifyRx(
        this.identity!,
        this.config!,
      );
      this.guard(token);
      // Count settling only after the last acknowledged RX configuration change.
      if (isStableHackrfApi(this.identity!.usbApiVersion)) {
        this.startTime = this.now();
        this.settledSamples = 0;
      }
      this.verifiedRx = true;
      const ready = await this.ready.promise;
      this.guard(token);
      return ready;
    });
  }
  stopRx(): Promise<void> {
    ++this.stopVersion;
    return this.shutdown();
  }
  close(): Promise<void> {
    ++this.stopVersion;
    this.terminal = true;
    return this.shutdown();
  }

  private protocol(token: number): HackrfProtocol {
    return new HackrfProtocol({
      now: this.now,
      pause: async (ms) => {
        await new Promise<void>((resolve) => setTimeout(resolve, ms));
        this.guard(token);
      },
      input: (request, value, index, length, minimumLength, timeoutMs) =>
        this.input(
          token,
          request,
          value,
          index,
          length,
          minimumLength,
          timeoutMs,
        ),
      output: (request, value, index, data) =>
        this.output(token, request, value, index, data),
    });
  }
  private setup(
    request: number,
    value: number,
    index: number,
  ): USBControlTransferParameters {
    return {
      requestType: "vendor",
      recipient: "device",
      request,
      value,
      index,
    };
  }
  private async input(
    token: number,
    request: number,
    value: number,
    index: number,
    length: number,
    minimumLength = length,
    timeoutMs = HACKRF_DEADLINE_MS,
  ): Promise<DataView> {
    this.guard(token);
    if (timeoutMs <= 0)
      throw new Error("HackRF settings polling deadline expired.");
    const raw = this.track(
      this.device!.controlTransferIn(this.setup(request, value, index), length),
    );
    this.control = raw;
    this.controlDeadline = this.now() + timeoutMs;
    const result = await this.deadline(raw, timeoutMs);
    this.guard(token);
    if (
      result.status !== "ok" ||
      !result.data ||
      result.data.byteLength < minimumLength ||
      result.data.byteLength > length
    )
      throw new Error(
        `HackRF control IN ${request} returned an invalid status/length.`,
      );
    return result.data;
  }
  private async output(
    token: number,
    request: number,
    value: number,
    index: number,
    data = new Uint8Array(0),
  ): Promise<void> {
    this.guard(token);
    const raw = this.track(
      this.device!.controlTransferOut(this.setup(request, value, index), data),
    );
    this.control = raw;
    this.controlDeadline = this.now() + HACKRF_DEADLINE_MS;
    const result = await this.deadline(raw);
    this.guard(token);
    if (result.status !== "ok" || result.bytesWritten !== data.byteLength)
      throw new Error(
        `HackRF control OUT ${request} returned an invalid status/length.`,
      );
  }

  private async pump(
    token: number,
    onBlock: (block: NativeIqBlock) => void,
    onReady?: (session: HackrfConfiguredSession) => void,
  ): Promise<void> {
    const submit = () => {
      this.guard(token);
      this.diag.readSlots++;
      this.diag.readSlotsHighWater = Math.max(
        this.diag.readSlotsHighWater,
        this.diag.readSlots,
      );
      // Slot stays occupied even when completed, until consumed in submission order.
      return this.track(this.device!.transferIn(1, HACKRF_READ_BYTES)).then(
        (result) => ({ ok: true as const, result, time: this.now() }),
        (error: unknown) => ({ ok: false as const, error }),
      );
    };
    const rate = this.session!.details.nativeSampleRateHz;
    const slotCount =
      rate === 2_400_000 ||
      rate === 4_800_000 ||
      rate === 9_600_000 ||
      rate === 19_200_000
        ? HACKRF_WIDEBAND_READ_SLOTS
        : HACKRF_READ_SLOTS;
    this.diag.rawSlotBytesLimit = slotCount * HACKRF_READ_BYTES;
    const slots = Array.from({ length: slotCount }, submit);
    let head = 0;
    try {
      while (this.streaming && token === this.token) {
        const completed = await this.deadline(slots[head]!);
        this.guard(token);
        if (!completed.ok) throw completed.error;
        const { result, time } = completed;
        if (
          result.status !== "ok" ||
          !result.data ||
          result.data.byteLength === 0 ||
          result.data.byteLength > HACKRF_READ_BYTES
        )
          throw new Error(
            "HackRF bulk input returned a stalled, empty or invalid transfer; stream continuity is unknown.",
          );
        // Re-arm the endpoint before dispatching this block. At 19.2 MS/s a
        // burst of completed promises can otherwise leave no USB read active
        // while the main thread copies and fans out earlier blocks.
        this.diag.readSlots--;
        slots[head] = submit();
        head = (head + 1) % slotCount;
        this.consume(result.data, time, onBlock, onReady);
        // The callback may synchronously stop/close this transport.
        if (!this.streaming) break;
      }
    } catch (error) {
      this.streamFailed(error, token);
      throw error;
    } finally {
      // All raw promises are also tracked by the device owner, even after timeout.
      await Promise.allSettled(slots);
      this.diag.readSlots = 0;
    }
  }
  private consume(
    view: DataView,
    time: number,
    onBlock: (block: NativeIqBlock) => void,
    onReady?: (session: HackrfConfiguredSession) => void,
  ): void {
    const assemblyStart = this.now();
    const input = new Uint8Array(view.buffer, view.byteOffset, view.byteLength);
    const prefix = this.carry === undefined ? 0 : 1;
    const length = Math.floor((input.length + prefix) / 2) * 2;
    if (prefix) {
      this.pairs[0] = this.carry!;
      this.pairs.set(input.subarray(0, length - prefix), prefix);
    }
    const pairedBytes = prefix
      ? this.pairs.subarray(0, length)
      : input.subarray(0, length);
    this.carry =
      input.length + prefix > length ? input[input.length - 1] : undefined;
    if (!length) return;
    this.timings.record("USB pair assembly", this.now() - assemblyStart);
    const samples = length / 2;
    const session = this.session!;
    if (
      !this.verifiedRx ||
      this.settledSamples <
        Math.ceil(0.12 * session.details.nativeSampleRateHz) +
          HACKRF_MAX_COMPLEX_SAMPLES ||
      time - this.startTime < 120
    ) {
      this.settledSamples += samples;
      this.diag.discardedSettlingSamples += samples;
      return;
    }
    if (this.diag.state === "starting") {
      this.diag.state = "running";
      this.callSync(onReady, structuredClone(session));
      this.ready!.resolve(structuredClone(session));
    }
    if (!this.streaming) return;
    const before = this.now();
    try {
      this.callSync(onBlock, {
        bytes: pairedBytes,
        encoding: "ci8",
        sampleOrder: "interleaved-iq",
        bytesPerComplexSample: 2,
        complexSampleCount: samples,
        nativeSampleRateHz: session.details.nativeSampleRateHz,
        generation: session.generation,
        sequence: this.sequence++,
        firstSampleIndex: this.sampleIndex,
        receivedAtMonotonicMs: time,
        discontinuityBefore: null,
      });
    } finally {
      this.timings.record("USB callback", this.now() - before);
    }
    this.sampleIndex += samples;
    const elapsed = this.now() - before;
    // Budget accumulated processing lag against the other fixed USB slots.
    // Counting consecutive overruns treats four 1 ms overshoots like four full
    // blocks of backlog, and falsely rejects recoverable startup/JIT jitter.
    const durationMs = (samples / session.details.nativeSampleRateHz) * 1_000;
    const budgetMs =
      (((this.diag.rawSlotBytesLimit / HACKRF_READ_BYTES - 1) *
        HACKRF_MAX_COMPLEX_SAMPLES) /
        session.details.nativeSampleRateHz) *
      1_000;
    this.consumerBudgetMs = budgetMs;
    this.consumerDebtMs = Math.max(
      0,
      this.consumerDebtMs + elapsed - durationMs,
    );
    if (elapsed >= HACKRF_DEADLINE_MS || this.consumerDebtMs >= budgetMs) {
      throw new Error(
        `HackRF mandatory sample consumer cannot sustain the input rate; continuity is unknown. Processing lag ${this.consumerDebtMs.toFixed(1)} ms exceeds ${budgetMs.toFixed(1)} ms bounded headroom (last callback ${elapsed.toFixed(1)} ms for ${durationMs.toFixed(1)} ms of samples).`,
      );
    }
  }
  private callSync<T>(
    callback: ((value: T) => void) | undefined,
    value: T,
  ): void {
    const returned: unknown = callback?.(value);
    if (
      returned &&
      typeof (returned as PromiseLike<unknown>).then === "function"
    ) {
      void Promise.resolve(returned).catch(() => undefined);
      throw new Error(
        "HackRF sample callbacks must consume synchronously or take a bounded copy.",
      );
    }
  }
  private streamFailed(error: unknown, token: number): void {
    if (token !== this.token) return;
    this.ready?.reject(error);
    if (this.config)
      this.diag.lastDiscontinuity = {
        generation: this.config.generation,
        missingSamples: null,
        reason: error instanceof Error ? error.message : "HackRF stream failed",
      };
    if (!this.errorReported) {
      this.errorReported = true;
      try {
        this.events.error?.(error);
      } catch {
        /* Observers cannot prevent resource cleanup. */
      }
    }
    void this.shutdown().catch(() => {
      /* diagnostics expose retryable cleanup-required */
    });
  }
  private shutdown(): Promise<void> {
    if (this.cleanupTask) return this.cleanupTask;
    if (this.diag.state === "closed") return Promise.resolve();
    if (
      (this.streaming || this.carry !== undefined) &&
      this.config &&
      this.diag.lastDiscontinuity?.generation !== this.config.generation
    ) {
      this.diag.lastDiscontinuity = {
        generation: this.config.generation,
        missingSamples: null,
        reason:
          this.carry === undefined
            ? "Acquisition reset"
            : "Partial I/Q pair discarded at acquisition reset",
      };
    }
    ++this.token;
    this.streaming = false;
    this.verifiedRx = false;
    this.ready?.reject(aborted());
    if (this.carry !== undefined) {
      this.diag.discardedPartialPairs++;
      this.carry = undefined;
    }
    this.diag.state = "closing";
    const cleanup = async () => {
      const warning = setTimeout(() => {
        try {
          this.events.cleanupWarning?.();
        } catch {
          /* Diagnostic observer only. */
        }
      }, HACKRF_DEADLINE_MS);
      try {
        // A permission/open success can arrive after cancellation. Own it before close.
        await Promise.allSettled([...this.acquisitions]);
        const device = this.device;
        if (device && this.needsClose) {
          // Never issue OFF concurrently with an outstanding control request.
          if (this.control && this.operations.has(this.control))
            await this.deadline(
              this.control,
              Math.max(0, this.controlDeadline - this.now()),
            ).catch(() => undefined);
          if (
            device.opened &&
            this.trustedIdentity &&
            (!this.control || !this.operations.has(this.control))
          ) {
            const off = this.track(
              device.controlTransferOut(this.setup(1, 0, 0), new Uint8Array(0)),
            );
            try {
              const result = await this.deadline(off);
              if (result.status !== "ok" || result.bytesWritten !== 0)
                throw new Error("HackRF OFF returned invalid status/length.");
            } catch (error) {
              this.diag.lastOffError =
                error instanceof Error ? error.message : String(error);
            }
            // OFF failure still proceeds to actual close, which owns cancellation.
          }
          await this.track(device.close());
          this.needsClose = false;
        }
        await Promise.allSettled([...this.operations]);
        await this.streamTask?.catch(() => undefined);
        this.trustedIdentity = false;
        this.identity = undefined;
        this.session = undefined;
        this.diag.state = this.terminal ? "closed" : "idle";
      } catch (error) {
        this.diag.state = "cleanup-required";
        throw error;
      } finally {
        clearTimeout(warning);
      }
    };
    const task = cleanup().finally(() => {
      if (this.cleanupTask === task) this.cleanupTask = undefined;
    });
    this.cleanupTask = task;
    return task;
  }
}

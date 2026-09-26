import {
  BLADERF_USB_ALT_IDLE,
  BLADERF_USB_ALT_RF_LINK,
  BLADERF_USB_INTERFACE,
  BLADERF_MAX_COMPLEX_SAMPLES,
  BLADERF_READ_BYTES,
  BLADERF_USB_FILTER,
  BladeRfProtocol,
  type BladeRfConfiguration,
  type BladeRfIdentity,
  type BladeRfSessionDetails,
} from "./bladerfProtocol";
import type { BladeRfHostedImage } from "./bladerfImages";

/** Bounded 4 MiB USB queue: ~437 ms at 2.4 MS/s, ~109 ms at 9.6 MS/s.
 * Browser rendering can stall the USB completion thread beyond the previous
 * eight-slot window and silently overflow the un-timestamped FPGA stream. */
export const BLADERF_READ_SLOTS = 64;
/** Preserve the same scheduling window when experimental 19.2 MS/s doubles the byte rate. */
export const BLADERF_HIGH_RATE_READ_SLOTS = 128;

export interface BladeRfNativeBlock {
  bytes: Uint8Array;
  encoding: "ci16_le_sc11";
  sampleOrder: "interleaved-iq";
  bytesPerComplexSample: 4;
  complexSampleCount: number;
  nativeSampleRateHz: number;
  generation: number;
  sequence: number;
  firstSampleIndex: number;
  receivedAtMonotonicMs: number;
}

export interface BladeRfConfiguredSession {
  generation: number;
  hardwareCenterFrequencyHz: number;
  details: BladeRfSessionDetails;
}

export interface BladeRfTransportEvents {
  error?(error: unknown): void;
  statusChanged?(message: string): void;
  loadImage?(image: BladeRfHostedImage): Promise<Uint8Array>;
}

const abortError = () =>
  new DOMException("bladeRF receive operation was cancelled.", "AbortError");
const timeout = (ms: number) =>
  new Promise<never>((_, reject) =>
    setTimeout(
      () =>
        reject(
          new DOMException("bladeRF USB reads did not stop.", "TimeoutError"),
        ),
      ms,
    ),
  );

export class BladeRfTransport {
  private device?: USBDevice;
  private protocol?: BladeRfProtocol;
  private identity?: BladeRfIdentity;
  private session?: BladeRfConfiguredSession;
  private state:
    | "idle"
    | "open"
    | "configured"
    | "starting"
    | "running"
    | "stopping"
    | "closing"
    | "closed" = "idle";
  private token = 0;
  private sequence = 0;
  private sampleIndex = 0;
  private reads = new Set<Promise<void>>();
  private callback?: (block: BladeRfNativeBlock) => void;
  private stopTask?: Promise<void>;
  private closeTask?: Promise<void>;

  constructor(private readonly events: BladeRfTransportEvents = {}) {}

  private get activeReadSlots(): number {
    return this.session?.details.nativeSampleRateHz === 19_200_000
      ? BLADERF_HIGH_RATE_READ_SLOTS
      : BLADERF_READ_SLOTS;
  }

  get diagnostics() {
    const slots = this.activeReadSlots;
    return {
      state: this.state,
      pendingOperations: this.reads.size,
      readSlots: this.state === "running" ? slots : 0,
      readSlotsHighWater: slots,
      rawSlotBytesLimit: slots * BLADERF_READ_BYTES,
      knownHardwareLoss: null,
      nativeEncoding: "ci16_le_sc11" as const,
    };
  }

  async requestAndOpen(
    usb: USB | undefined = navigator.usb,
  ): Promise<BladeRfIdentity> {
    if (!usb)
      throw new DOMException(
        "This browser does not support WebUSB.",
        "RadioError.NoUsbSupport",
      );
    if (this.device) return this.identity!;
    const device = await usb.requestDevice({
      filters: [{ ...BLADERF_USB_FILTER }],
    });
    return this.open(device);
  }

  async open(device: USBDevice): Promise<BladeRfIdentity> {
    if (this.device) return structuredClone(this.identity!);
    try {
      if (!device.opened) await device.open();
      if (!device.configuration) await device.selectConfiguration(1);
      await device.claimInterface(0);
      const protocol = new BladeRfProtocol(device, {
        statusChanged: this.events.statusChanged,
        loadImage: this.events.loadImage,
      });
      const identity = await protocol.open();
      this.device = device;
      this.protocol = protocol;
      this.identity = identity;
      this.state = "open";
      return structuredClone(identity);
    } catch (error) {
      await device.close().catch(() => undefined);
      throw error;
    }
  }

  async configure(
    configuration: BladeRfConfiguration,
    generation: number,
  ): Promise<BladeRfConfiguredSession> {
    if (
      !this.protocol ||
      !this.identity ||
      !["open", "configured"].includes(this.state)
    )
      throw new DOMException(
        "Open and stop the bladeRF before configuring it.",
        "InvalidStateError",
      );
    const details = await this.protocol.configure(configuration);
    this.session = {
      generation,
      hardwareCenterFrequencyHz: details.acceptedCenterFrequencyHz,
      details,
    };
    this.state = "configured";
    return structuredClone(this.session);
  }

  async startRx(
    callback: (block: BladeRfNativeBlock) => void,
    ready: (session: BladeRfConfiguredSession) => void,
  ): Promise<void> {
    if (
      !this.device ||
      !this.protocol ||
      !this.session ||
      this.state !== "configured"
    )
      throw new DOMException(
        "Configure the bladeRF before starting RX.",
        "InvalidStateError",
      );
    const token = ++this.token;
    this.state = "starting";
    this.callback = callback;
    this.sequence = 0;
    this.sampleIndex = 0;
    await this.protocol.setRxEnabled(true);
    if (token !== this.token || this.state !== "starting") throw abortError();
    this.state = "running";
    ready(structuredClone(this.session));
    for (let slot = 0; slot < this.activeReadSlots; slot += 1)
      this.scheduleRead(token);
  }

  private scheduleRead(token: number): void {
    if (!this.device || token !== this.token || this.state !== "running")
      return;
    const task = this.device
      .transferIn(1, BLADERF_READ_BYTES)
      .then((result) => {
        if (token !== this.token || this.state !== "running") return;
        const view = result.data;
        if (result.status !== "ok" || !view)
          throw new DOMException(
            `bladeRF sample transfer returned ${result.status}.`,
            "NetworkError",
          );
        const source = new Uint8Array(
          view.buffer,
          view.byteOffset,
          view.byteLength,
        );
        if (source.byteLength === 0) return;
        if (
          source.byteLength % 4 !== 0 ||
          source.byteLength > BLADERF_READ_BYTES
        )
          throw new Error(
            "bladeRF returned a truncated or oversized SC16 Q11 block.",
          );
        const complexSampleCount = source.byteLength / 4;
        if (complexSampleCount > BLADERF_MAX_COMPLEX_SAMPLES)
          throw new Error(
            "bladeRF sample block exceeds the fixed receive slot.",
          );
        const firstSampleIndex = this.sampleIndex;
        this.sampleIndex += complexSampleCount;
        this.callback?.({
          bytes: source,
          encoding: "ci16_le_sc11",
          sampleOrder: "interleaved-iq",
          bytesPerComplexSample: 4,
          complexSampleCount,
          nativeSampleRateHz: this.session!.details.nativeSampleRateHz,
          generation: this.session!.generation,
          sequence: this.sequence++,
          firstSampleIndex,
          receivedAtMonotonicMs: performance.now(),
        });
      })
      .catch((error) => {
        if (token === this.token && this.state === "running") {
          ++this.token;
          this.state = "configured";
          this.events.error?.(error);
        }
      })
      .finally(() => {
        this.reads.delete(task);
        if (token === this.token && this.state === "running")
          this.scheduleRead(token);
      });
    this.reads.add(task);
  }

  stopRx(): Promise<void> {
    if (this.stopTask) return this.stopTask;
    if (!this.protocol || !["starting", "running"].includes(this.state))
      return Promise.resolve();
    ++this.token;
    this.state = "stopping";
    this.callback = undefined;
    const task = (async () => {
      await this.protocol!.setRxEnabled(false);
      // Disabling RX does not guarantee that Chrome's already-submitted bulk
      // reads settle. Changing away from the RF-link alternate explicitly
      // aborts every transfer on its endpoints per WebUSB, then restores the
      // command/sample endpoints for reconfiguration or restart.
      await this.device!.selectAlternateInterface(
        BLADERF_USB_INTERFACE,
        BLADERF_USB_ALT_IDLE,
      );
      await this.device!.selectAlternateInterface(
        BLADERF_USB_INTERFACE,
        BLADERF_USB_ALT_RF_LINK,
      );
      if (this.reads.size)
        await Promise.race([
          Promise.allSettled([...this.reads]),
          timeout(1_500),
        ]);
      this.reads.clear();
      this.state = "configured";
    })().finally(() => {
      if (this.stopTask === task) this.stopTask = undefined;
    });
    this.stopTask = task;
    return task;
  }

  close(): Promise<void> {
    if (this.closeTask) return this.closeTask;
    if (!this.device) {
      this.state = "closed";
      return Promise.resolve();
    }
    ++this.token;
    this.state = "closing";
    this.callback = undefined;
    const device = this.device;
    const protocol = this.protocol;
    const task = (async () => {
      if (protocol) await protocol.setRxEnabled(false).catch(() => undefined);
      await device.close();
      this.reads.clear();
      this.device = undefined;
      this.protocol = undefined;
      this.identity = undefined;
      this.session = undefined;
      this.state = "closed";
    })().finally(() => {
      if (this.closeTask === task) this.closeTask = undefined;
    });
    this.closeTask = task;
    return task;
  }
}

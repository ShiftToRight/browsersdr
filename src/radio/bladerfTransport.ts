import { openBrowserUsbDevice, closeBrowserUsbDevice } from "./browserUsbOwnership";
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
    | "opening"
    | "open"
    | "configured"
    | "starting"
    | "running"
    | "stopping"
    | "closing"
    | "closed" = "idle";
  private token = 0;
  private openingGeneration = 0;
  private opening?: { generation: number; task: Promise<BladeRfIdentity> };
  private readonly openingOwners = new Map<USBDevice, object>();
  private readonly cleanupOwners = new Map<USBDevice, object>();
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
    return this.beginOpen(() =>
      usb.requestDevice({ filters: [{ ...BLADERF_USB_FILTER }] }),
    );
  }

  async open(device: USBDevice): Promise<BladeRfIdentity> {
    return this.beginOpen(async () => device);
  }

  private beginOpen(
    selectDevice: () => Promise<USBDevice>,
  ): Promise<BladeRfIdentity> {
    if (this.closeTask || this.stopTask) return Promise.reject(abortError());
    if (this.state === "closing" || this.cleanupOwners.size)
      return Promise.reject(
        new DOMException(
          "bladeRF USB cleanup is incomplete; retry disconnect before reopening.",
          "InvalidStateError",
        ),
      );
    if (this.device) return Promise.resolve(structuredClone(this.identity!));
    if (this.opening?.generation === this.openingGeneration)
      return this.opening.task;
    const generation = ++this.openingGeneration;
    this.state = "opening";
    const task = this.openSelected(selectDevice, generation).finally(() => {
      if (this.opening?.task === task) {
        this.opening = undefined;
        if (!this.device)
          this.state = this.cleanupOwners.size ? "closing" : "closed";
      }
    });
    this.opening = { generation, task };
    return task;
  }

  private async openSelected(
    selectDevice: () => Promise<USBDevice>,
    generation: number,
  ): Promise<BladeRfIdentity> {
    let opening = true;
    const checkCurrent = () => {
      if (opening && generation !== this.openingGeneration) throw abortError();
    };
    const current = async <T>(operation: () => Promise<T>): Promise<T> => {
      checkCurrent();
      try {
        return await operation();
      } finally {
        checkCurrent();
      }
    };
    // A cancelled chooser never owns, opens or closes the returned device.
    const device = await current(selectDevice);
    const owner = {};
    if (this.openingOwners.has(device))
      throw new DOMException(
        "A previous bladeRF opening operation is still cleaning up this device.",
        "InvalidStateError",
      );
    // Bound retained devices even if canceled WebUSB operations never settle.
    if (this.openingOwners.size >= 8)
      throw new DOMException(
        "Too many bladeRF opening operations are still pending cleanup.",
        "InvalidStateError",
      );
    this.openingOwners.set(device, owner);
    let owned = device.opened;
    try {
      if (!device.opened) {
        // open() may succeed in the browser before its promise rejects/cancels.
        owned = true;
        await current(() => openBrowserUsbDevice(device));
      }
      if (device.configuration?.configurationValue !== 1)
        await current(() => device.selectConfiguration(1));
      checkCurrent();
      owned = true;
      await current(() => device.claimInterface(0));
      const protocol = new BladeRfProtocol(device, {
        statusChanged: this.events.statusChanged,
        loadImage: this.events.loadImage,
        checkCurrent,
      });
      const identity = await protocol.open();
      try {
        checkCurrent();
      } catch (error) {
        if (identity.volatileImage && error instanceof DOMException)
          throw new DOMException(
            `${error.message} Volatile FPGA state may have changed; reconnect or power-cycle before retrying. No rollback was performed.`,
            error.name,
          );
        throw error;
      }
      this.device = device;
      this.protocol = protocol;
      this.identity = identity;
      this.state = "open";
      opening = false;
      return structuredClone(identity);
    } catch (error) {
      // Cleanup is local: a stale attempt cannot erase a newer published session.
      if (owned && this.openingOwners.get(device) === owner) {
        if (
          device.configuration?.interfaces.find(
            (iface) => iface.interfaceNumber === 0,
          )?.claimed
        )
          await device.releaseInterface?.(0).catch(() => undefined);
        await closeBrowserUsbDevice(device).catch(() => undefined);
        if (device.opened) this.cleanupOwners.set(device, owner);
      }
      throw error;
    } finally {
      if (
        this.openingOwners.get(device) === owner &&
        this.cleanupOwners.get(device) !== owner
      )
        this.openingOwners.delete(device);
    }
  }

  async configure(
    configuration: BladeRfConfiguration,
    generation: number,
  ): Promise<BladeRfConfiguredSession> {
    if (
      this.cleanupOwners.size ||
      !this.protocol ||
      !this.identity ||
      !["open", "configured"].includes(this.state)
    )
      throw new DOMException(
        "Open and stop the bladeRF before configuring it.",
        "InvalidStateError",
      );
    const protocol = this.protocol;
    const token = this.token;
    const details = await protocol.configure(configuration);
    if (token !== this.token || this.protocol !== protocol) throw abortError();
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
      this.cleanupOwners.size ||
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
    ++this.openingGeneration;
    if (this.stopTask) return this.stopTask;
    if (!this.protocol || !["starting", "running"].includes(this.state))
      return Promise.resolve();
    const token = ++this.token;
    const protocol = this.protocol;
    const device = this.device!;
    const checkCurrent = () => {
      if (token !== this.token || this.protocol !== protocol)
        throw abortError();
    };
    this.state = "stopping";
    this.callback = undefined;
    const task = (async () => {
      await protocol.setRxEnabled(false);
      checkCurrent();
      // Disabling RX does not guarantee that Chrome's already-submitted bulk
      // reads settle. Changing away from the RF-link alternate explicitly
      // aborts every transfer on its endpoints per WebUSB, then restores the
      // command/sample endpoints for reconfiguration or restart.
      await device.selectAlternateInterface(
        BLADERF_USB_INTERFACE,
        BLADERF_USB_ALT_IDLE,
      );
      checkCurrent();
      await device.selectAlternateInterface(
        BLADERF_USB_INTERFACE,
        BLADERF_USB_ALT_RF_LINK,
      );
      checkCurrent();
      if (this.reads.size)
        await Promise.race([
          Promise.allSettled([...this.reads]),
          timeout(1_500),
        ]);
      checkCurrent();
      this.reads.clear();
      this.state = "configured";
    })().finally(() => {
      if (this.stopTask === task) this.stopTask = undefined;
    });
    this.stopTask = task;
    return task;
  }

  close(): Promise<void> {
    ++this.openingGeneration;
    if (this.closeTask) return this.closeTask;
    ++this.token;
    this.state = "closing";
    this.callback = undefined;
    const device = this.device;
    const protocol = this.protocol;
    // Published identity and configuration cease to be usable on first close,
    // while the actual USB device remains owned until closure is confirmed.
    this.protocol = undefined;
    this.identity = undefined;
    this.session = undefined;
    const task = (async () => {
      let failure: unknown;
      if (device) {
        if (protocol) await protocol.setRxEnabled(false).catch(() => undefined);
        try {
          await closeBrowserUsbDevice(device);
          if (device.opened)
            throw new DOMException(
              "bladeRF USB device is still open after close.",
              "NetworkError",
            );
        } catch (error) {
          if (device.opened) failure = error;
        } finally {
          if (!device.opened && this.device === device) {
            this.reads.clear();
            this.device = undefined;
          }
        }
      }
      // Each explicit close makes one bounded retry for each failed opening.
      for (const [pending, owner] of this.cleanupOwners) {
        if (this.openingOwners.get(pending) !== owner) continue;
        if (
          pending.configuration?.interfaces.find(
            (iface) => iface.interfaceNumber === 0,
          )?.claimed
        )
          await pending.releaseInterface?.(0).catch(() => undefined);
        try {
          await pending.close();
          if (pending.opened)
            throw new DOMException(
              "bladeRF opening cleanup left the USB device open.",
              "NetworkError",
            );
        } catch (error) {
          if (pending.opened) failure ??= error;
        } finally {
          if (!pending.opened && this.cleanupOwners.get(pending) === owner) {
            this.cleanupOwners.delete(pending);
            this.openingOwners.delete(pending);
          }
        }
      }
      if (failure) throw failure;
    })().finally(() => {
      if (this.closeTask === task) {
        this.closeTask = undefined;
        this.state =
          this.device || this.cleanupOwners.size ? "closing" : "closed";
      }
    });
    this.closeTask = task;
    return task;
  }
}

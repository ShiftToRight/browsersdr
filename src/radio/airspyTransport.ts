import { airspyGainStages } from "./airspyGain";
import {
  openBrowserUsbDevice,
  closeBrowserUsbDevice,
} from "./browserUsbOwnership";
import {
  AIRSPY_USB_FILTER,
  AIRSPY_SAMPLE_RATES,
  validateAirspySettings,
  type AirspyIdentity,
  type AirspySettings,
} from "./airspySettings";

const setup = (
  request: number,
  value = 0,
  index = 0,
): USBControlTransferParameters => ({
  requestType: "vendor",
  recipient: "device",
  request,
  value,
  index,
});
const timeout = <T>(task: Promise<T>): Promise<T> =>
  new Promise((resolve, reject) => {
    const timer = setTimeout(
      () =>
        reject(
          new Error(
            "Airspy USB operation timed out. Disconnect and reconnect the receiver.",
          ),
        ),
      3000,
    );
    void task.then(resolve, reject).finally(() => clearTimeout(timer));
  });
/** One WebUSB owner, bounded ordered bulk reads. No firmware, flash, TX or GPIO API. */
export class AirspyTransport {
  private device?: USBDevice;
  private owned = false;
  private epoch = 0;
  private running = false;
  private pump?: Promise<void>;
  private stopTask?: Promise<void>;
  identity?: AirspyIdentity;
  constructor(private readonly error: (error: unknown) => void) {}
  async requestAndOpen(
    usb: USB | undefined = navigator.usb,
  ): Promise<AirspyIdentity> {
    if (!usb) throw new Error("This browser does not support WebUSB.");
    return this.open(await usb.requestDevice({ filters: [AIRSPY_USB_FILTER] }));
  }
  async open(device: USBDevice): Promise<AirspyIdentity> {
    if (
      device.vendorId !== AIRSPY_USB_FILTER.vendorId ||
      device.productId !== AIRSPY_USB_FILTER.productId
    )
      throw new Error(
        "Choose an Airspy R2 or Mini. HF+ uses a different protocol.",
      );
    this.device = device;
    try {
      await openBrowserUsbDevice(device);
      this.owned = true;
      if (!device.configuration) await device.selectConfiguration(1);
      const iface = device.configuration?.interfaces.find(
        (item) => item.interfaceNumber === 0,
      );
      const alternate = iface?.alternates?.find(
        (item) =>
          item.alternateSetting === 0 &&
          item.interfaceClass === 255 &&
          item.endpoints.some(
            (endpoint) =>
              endpoint.direction === "in" &&
              endpoint.endpointNumber === 1 &&
              endpoint.type === "bulk",
          ),
      );
      if (!alternate)
        throw new Error(
          "Airspy USB descriptors do not match the receive profile.",
        );
      await device.claimInterface(0);
      await this.out(1, 0);
      // Physical antenna power is always opt-in for this connection.
      await this.bias(false);
      const boardId = (await this.input(9, 1)).getUint8(0);
      if (boardId !== 0)
        throw new Error(`Unsupported Airspy board ID ${boardId}.`);
      const version = await this.input(10, 127, 0, false);
      const firmware = new TextDecoder().decode(version).replace(/\0.*$/s, "");
      if (!firmware.startsWith("AirSpy"))
        throw new Error("Unrecognized Airspy firmware identity.");
      const id = await this.input(11, 24);
      const serial = [id.getUint32(16, true), id.getUint32(20, true)]
        .map((word) => word.toString(16).padStart(8, "0"))
        .join("");
      const count = (await this.input(25, 4)).getUint32(0, true);
      if (count < 1 || count > 32)
        throw new Error("Invalid Airspy sample-rate count.");
      const rates = await this.input(25, count * 4, count);
      const sampleRates = Array.from({ length: count }, (_, n) =>
        rates.getUint32(n * 4, true),
      );
      if (
        !sampleRates.every((rate) =>
          (AIRSPY_SAMPLE_RATES as readonly number[]).includes(rate),
        )
      )
        throw new Error(
          `Airspy firmware advertises an unqualified rate set: ${sampleRates.join(", ")}.`,
        );
      this.identity = {
        boardId,
        firmware,
        serial,
        sampleRates,
        rateProfile: sampleRates.includes(6_000_000) ? "mini" : "r2",
      };
      return structuredClone(this.identity);
    } catch (error) {
      await this.close().catch(() => undefined);
      throw error;
    }
  }
  private async input(
    request: number,
    length: number,
    index = 0,
    exact = true,
  ): Promise<DataView> {
    const result = await timeout(
      this.device!.controlTransferIn(setup(request, 0, index), length),
    );
    if (
      result.status !== "ok" ||
      !result.data ||
      (exact ? result.data.byteLength !== length : result.data.byteLength < 1)
    )
      throw new Error(
        `Airspy USB request ${request} returned ${result.status} or a short response.`,
      );
    return result.data;
  }
  private async out(
    request: number,
    value = 0,
    index = 0,
    bytes?: Uint8Array<ArrayBuffer>,
  ): Promise<void> {
    const result = await timeout(
      this.device!.controlTransferOut(setup(request, value, index), bytes),
    );
    if (result.status !== "ok" || result.bytesWritten !== (bytes?.length ?? 0))
      throw new Error(
        `Airspy USB request ${request} failed or wrote incomplete data.`,
      );
  }
  private async setting(request: number, index: number): Promise<void> {
    const result = await this.input(request, 1, index);
    if (result.getUint8(0) !== (request === 12 || request === 26 ? 1 : 0))
      throw new Error(
        `Airspy rejected setting ${request} (${result.getUint8(0)}).`,
      );
  }
  private bias(enabled: boolean) {
    return this.out(21, enabled ? 1 : 0, (1 << 5) | 13);
  }
  async configure(
    rate: number,
    frequency: number,
    settings: AirspySettings,
  ): Promise<number> {
    const s = validateAirspySettings(settings);
    if (this.running)
      throw new Error("Stop Airspy before changing sample format or rate.");
    if (!this.device?.opened) {
      if (!this.device) throw new Error("Connect Airspy first.");
      await this.open(this.device);
    }
    const index = this.identity!.sampleRates.indexOf(rate);
    if (index < 0)
      throw new Error(
        "This Airspy does not advertise the selected sample rate.",
      );
    await this.device!.clearHalt?.("in", 1);
    await this.setting(12, index);
    await this.setting(26, Number(s.packing));
    const corrected = Math.round(frequency * (1 + s.ppm / 1_000_000));
    if (
      !Number.isSafeInteger(corrected) ||
      corrected < 24_000_000 ||
      corrected > 1_800_000_000
    )
      throw new Error("Airspy corrected frequency must fit 24–1800 MHz.");
    const bytes = new Uint8Array(4);
    new DataView(bytes.buffer).setUint32(0, corrected, true);
    await this.out(13, 0, 0, bytes);
    await this.gains(s);
    return corrected;
  }
  async gains(settings: AirspySettings): Promise<void> {
    const s = validateAirspySettings(settings),
      stages = airspyGainStages(s);
    await this.setting(17, Number(stages.lnaAgc));
    await this.setting(18, Number(stages.mixerAgc));
    await this.setting(16, stages.vga);
    await this.setting(15, stages.mixer);
    await this.setting(14, stages.lna);
    await this.bias(s.biasTee);
  }
  async start(
    packing: boolean,
    receive: (bytes: Uint8Array<ArrayBuffer>) => void | Promise<void>,
  ): Promise<void> {
    if (this.running) return;
    if (!this.device?.opened)
      throw new Error("Configure Airspy before receiving.");
    const epoch = ++this.epoch;
    await this.out(1, 1);
    this.running = true;
    const device = this.device;
    const length = packing ? 49_152 : 65_536;
    // FIFO promises preserve transfer submission order even when callbacks settle out of order.
    const read = () => {
      const result = device.transferIn(1, length);
      void result.catch(() => undefined);
      return result;
    };
    const reads = Array.from({ length: 16 }, read);
    this.pump = (async () => {
      let delivered = 0;
      while (this.running && epoch === this.epoch) {
        const result = await timeout(reads.shift()!);
        if (!this.running || epoch !== this.epoch) return;
        reads.push(read());
        if (result.status !== "ok" || !result.data?.byteLength)
          throw new Error(
            `Airspy stream ${result.status}; sample loss is unknown.`,
          );
        const consumed = receive(
          new Uint8Array(
            result.data.buffer,
            result.data.byteOffset,
            result.data.byteLength,
          ).slice(),
        );
        // Retain the sixteen submitted reads while the consumer gives worker
        // replies a task turn. No raw buffer is discarded or re-ordered.
        if (consumed) await timeout(consumed);
        // A burst of already-completed USB promises can monopolize microtasks.
        // Let conversion replies, audio and rendering run after each read ring.
        // All sixteen replacement reads are already submitted during this yield.
        if (++delivered % 16 === 0)
          await new Promise<void>((resolve) => setTimeout(resolve, 0));
      }
    })();
    void this.pump.catch((error) => {
      if (epoch === this.epoch && this.running) {
        this.running = false;
        this.error(error);
      }
    });
  }
  stop(): Promise<void> {
    return (this.stopTask ??= this.shutdown().finally(() => {
      this.stopTask = undefined;
    }));
  }
  private async shutdown(): Promise<void> {
    this.running = false;
    ++this.epoch;
    if (!this.device?.opened || !this.owned) return;
    let failure: unknown;
    try {
      await this.out(1, 0);
      await this.bias(false);
    } catch (error) {
      failure = error;
    }
    // WebUSB has no cancelTransfer. Close cancels outstanding reads; reopen on next Start.
    await timeout(closeBrowserUsbDevice(this.device));
    this.owned = false;
    await this.pump?.catch(() => undefined);
    if (failure) throw failure;
  }
  close() {
    return this.stop();
  }
}

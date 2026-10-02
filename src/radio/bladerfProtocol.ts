import {
  BLADERF_GAIN_MODES,
  DEFAULT_BLADERF_RX_SETTINGS,
  bladeRfGainRange,
  validateBladeRfRxSettings,
  type BladeRfGainMode,
  type BladeRfRxSettings,
} from "./bladerfSettings";
/**
 * Receive-only bladeRF 2.0 Micro protocol profiles.
 *
 * This is a clean TypeScript implementation of the public Nuand USB/NIOS wire
 * formats. It may load verified user-imported gateware into volatile RAM; it never
 * flashes firmware/gateware and never enables TX.
 * Reference: Nuand/bladeRF commit 35174c30b009cdb335800c411f3c14d45283f12b.
 */
import {
  loadStoredBladeRfImage,
  selectBladeRfImage,
  verifyBladeRfImage,
  type BladeRfHostedImage,
} from "./bladerfImages";

import {
  detectBladeRfMicroModel,
  type BladeRfDetection,
  type BladeRfDetectionEvidence,
} from "./bladerfDetection";
import {
  assertBladeRfMicroModel,
  bladeRfModelValidation,
  type BladeRfMicroModel,
  type BladeRfVariantValidation,
} from "./bladerfModels";

export const BLADERF_REFERENCE_COMMIT =
  "35174c30b009cdb335800c411f3c14d45283f12b" as const;
export const BLADERF_PROTOCOL_PROFILE =
  "bladerf2-xa4-fpga-rfic-35174c3-v1" as const;
export type BladeRfProtocolProfile =
  | typeof BLADERF_PROTOCOL_PROFILE
  | "bladerf2-xa5-fpga-rfic-35174c3-v1"
  | "bladerf2-xa9-fpga-rfic-35174c3-v1";
export function bladeRfProtocolProfile(
  model: BladeRfMicroModel,
): BladeRfProtocolProfile {
  assertBladeRfMicroModel(model);
  return model === "xA4"
    ? BLADERF_PROTOCOL_PROFILE
    : model === "xA5"
      ? "bladerf2-xa5-fpga-rfic-35174c3-v1"
      : "bladerf2-xa9-fpga-rfic-35174c3-v1";
}
export const BLADERF_USB_FILTER = {
  vendorId: 0x2cf0,
  productId: 0x5250,
} as const;
export const BLADERF_READ_BYTES = 65_536;
export const BLADERF_MAX_COMPLEX_SAMPLES = BLADERF_READ_BYTES / 4;

export const BLADERF_USB_INTERFACE = 0;
export const BLADERF_USB_ALT_IDLE = 0;
export const BLADERF_USB_ALT_RF_LINK = 1;
const USB_ALT_FPGA_CONFIG = 3;
const SAMPLE_ENDPOINT_IN = 1;
const PERIPHERAL_ENDPOINT_OUT = 2;
const PERIPHERAL_ENDPOINT_IN = 2;
const NIOS_PACKET_BYTES = 16;

const BLADE_USB_CMD_QUERY_VERSION = 0;
const BLADE_USB_CMD_QUERY_FPGA_STATUS = 1;
const BLADE_USB_CMD_BEGIN_PROG = 2;
const BLADE_USB_CMD_RF_RX = 4;
const BLADE_USB_CMD_QUERY_DEVICE_READY = 6;

const RFIC_SYSTEM_CHANNEL = 0x0f;
const RFIC_RX_CHANNELS = [0x00, 0x02] as const;
const RFIC_STATUS = 0x00;
const RFIC_INIT = 0x01;
const RFIC_ENABLE = 0x02;
const RFIC_SAMPLE_RATE = 0x03;
const RFIC_FREQUENCY = 0x04;
const RFIC_BANDWIDTH = 0x05;
const RFIC_GAIN_MODE = 0x06;
const RFIC_GAIN = 0x07;
const RFIC_INIT_ON = 1;

const GPIO_TIMESTAMP = 1 << 16;
const GPIO_PACKET = 1 << 19;
const GPIO_8BIT_MODE = 1 << 20;
const GPIO_HIGHLY_PACKED_MODE = 1 << 21;
const GPIO_SMALL_DMA_TRANSFER = 1 << 7;

export interface BladeRfVersion {
  major: number;
  minor: number;
  patch: number;
}
export interface BladeRfIdentity {
  kind: "bladerf-2-micro-xa4" | "bladerf-2-micro-xa5" | "bladerf-2-micro-xa9";
  model: BladeRfMicroModel;
  detection: BladeRfDetectionEvidence;
  variantValidation: BladeRfVariantValidation;
  vendorId: 0x2cf0;
  productId: 0x5250;
  serialNumber: string | null;
  firmware: Omit<BladeRfVersion, "patch">;
  fpga: BladeRfVersion;
  usbPacketSize: 512 | 1024;
  volatileImage: Pick<
    BladeRfHostedImage,
    "model" | "version" | "sha256"
  > | null;
}
export interface BladeRfSessionDetails {
  protocolProfile: BladeRfProtocolProfile;
  referenceCommit: typeof BLADERF_REFERENCE_COMMIT;
  identity: BladeRfIdentity;
  nativeEncoding: "ci16_le_sc11";
  /** Nominal stream rate requested from the fixed BrowserSDR profile. */
  nativeSampleRateHz: number;
  /** RFIC readback; may differ slightly because the AD9361 clock is quantized. */
  acceptedSampleRateHz: number;
  effectiveSampleRateHz: number;
  requestedCenterFrequencyHz: number;
  acceptedCenterFrequencyHz: number;
  requestedBandwidthHz: number;
  acceptedBandwidthHz: number;
  gainMode: BladeRfGainMode;
  rxInput?: BladeRfRxSettings["rxInput"];
  requestedGainDb?: number | null;
  /** Manual mode readback only; AGC gain is dynamic. */
  acceptedGainDb?: number | null;
  rxSettings?: BladeRfRxSettings;
  hardwareValidation: "pending";
}
export interface BladeRfConfiguration {
  rxSettings?: BladeRfRxSettings;
  centerFrequencyHz: number;
  sampleRateHz: 2_400_000 | 4_800_000 | 9_600_000 | 19_200_000;
  bandwidthHz: number;
}

export interface BladeRfProtocolOptions {
  loadImage?: (image: BladeRfHostedImage) => Promise<Uint8Array>;
  statusChanged?(message: string): void;
  allowVolatileFpgaLoad?: boolean;
  checkCurrent?: () => void;
}

const versionText = (
  version: BladeRfVersion | Omit<BladeRfVersion, "patch">,
) =>
  "patch" in version
    ? `${version.major}.${version.minor}.${version.patch}`
    : `${version.major}.${version.minor}`;

function bytes(view: DataView | null | undefined): Uint8Array {
  if (!view) return new Uint8Array();
  return new Uint8Array(view.buffer, view.byteOffset, view.byteLength);
}

function checkIn(
  result: USBInTransferResult,
  expected: number,
  operation: string,
): Uint8Array {
  const value = bytes(result.data);
  if (result.status !== "ok" || value.byteLength !== expected)
    throw new DOMException(
      `bladeRF ${operation} returned ${result.status} with ${value.byteLength}/${expected} bytes.`,
      "NetworkError",
    );
  return value;
}

function checkOut(
  result: USBOutTransferResult,
  expected: number,
  operation: string,
): void {
  if (result.status !== "ok" || result.bytesWritten !== expected)
    throw new DOMException(
      `bladeRF ${operation} returned ${result.status} with ${result.bytesWritten}/${expected} bytes.`,
      "NetworkError",
    );
}

function u64le(data: Uint8Array, offset: number): bigint {
  let value = 0n;
  for (let index = 7; index >= 0; index -= 1)
    value = (value << 8n) | BigInt(data[offset + index]!);
  return value;
}

export function packBladeRfRficRequest(
  write: boolean,
  command: number,
  channel: number,
  value = 0n,
): Uint8Array {
  if (
    !Number.isInteger(command) ||
    command < 0 ||
    command > 0xff ||
    !Number.isInteger(channel) ||
    channel < 0 ||
    channel > 0x0f ||
    value < 0n ||
    value > 0xffff_ffff_ffff_ffffn
  )
    throw new Error("Invalid bladeRF RFIC request.");
  const packet = new Uint8Array(NIOS_PACKET_BYTES);
  packet[0] = 0x45; // NIOS 16x64 magic 'E'
  packet[1] = 0x01; // RFIC target
  packet[2] = write ? 0x01 : 0;
  const address = command | (channel << 8);
  packet[4] = address & 0xff;
  packet[5] = address >>> 8;
  let remaining = value;
  for (let index = 0; index < 8; index += 1) {
    packet[6 + index] = Number(remaining & 0xffn);
    remaining >>= 8n;
  }
  return packet;
}

export function unpackBladeRfRficResponse(
  packet: Uint8Array,
  write: boolean,
  command: number,
  channel: number,
): bigint {
  const address = command | (channel << 8);
  if (
    packet.byteLength !== NIOS_PACKET_BYTES ||
    packet[0] !== 0x45 ||
    packet[1] !== 0x01 ||
    (packet[2]! & 0x01) !== (write ? 1 : 0) ||
    (packet[2]! & 0x02) === 0 ||
    packet[4] !== (address & 0xff) ||
    packet[5] !== address >>> 8
  )
    throw new Error("bladeRF rejected or mismatched an RFIC command response.");
  return u64le(packet, 6);
}

function packGpioRequest(write: boolean, value = 0): Uint8Array {
  const packet = new Uint8Array(NIOS_PACKET_BYTES);
  packet[0] = 0x43; // NIOS 8x32 magic 'C'
  packet[1] = 0x01; // control/config register
  packet[2] = write ? 0x01 : 0;
  new DataView(packet.buffer).setUint32(5, value >>> 0, true);
  return packet;
}

function unpackGpioResponse(packet: Uint8Array, write: boolean): number {
  if (
    packet.byteLength !== NIOS_PACKET_BYTES ||
    packet[0] !== 0x43 ||
    packet[1] !== 0x01 ||
    (packet[2]! & 0x01) !== (write ? 1 : 0) ||
    (packet[2]! & 0x02) === 0 ||
    packet[4] !== 0
  )
    throw new Error("bladeRF rejected or mismatched a configuration response.");
  return new DataView(
    packet.buffer,
    packet.byteOffset,
    packet.byteLength,
  ).getUint32(5, true);
}

function validateProfile(
  firmware: Omit<BladeRfVersion, "patch">,
  fpga: BladeRfVersion,
): void {
  const fwOk =
    firmware.major === 2 &&
    ((fpga.minor === 15 && firmware.minor === 4) ||
      (fpga.minor === 16 && fpga.patch === 0 && firmware.minor >= 5));
  const fpgaOk =
    fpga.major === 0 &&
    ((fpga.minor === 15 && fpga.patch >= 0 && fpga.patch <= 3) ||
      (fpga.minor === 16 && fpga.patch === 0));
  if (!fwOk || !fpgaOk)
    throw new Error(
      `bladeRF 2.0 Micro requires the pinned receive profile (firmware 2.4 with FPGA 0.15.0–0.15.3, or firmware 2.5+ with FPGA 0.16.0). Detected firmware ${versionText(firmware)}, FPGA ${versionText(fpga)}. BrowserSDR will not replace an already configured FPGA or update firmware.`,
    );
}

export class BladeRfProtocol {
  private queue = Promise.resolve<unknown>(undefined);
  private rxChannel: 0 | 2 = 0;
  private programmingDispatched = false;

  private checkCurrent(): void {
    this.options.checkCurrent?.();
  }

  // Check even rejected USB/provider promises so cancellation retains its identity.
  private async current<T>(operation: () => Promise<T>): Promise<T> {
    this.checkCurrent();
    try {
      return await operation();
    } finally {
      this.checkCurrent();
    }
  }

  private status(message: string): void {
    this.checkCurrent();
    this.options.statusChanged?.(message);
    this.checkCurrent();
  }
  constructor(
    private readonly device: USBDevice,
    private readonly options: BladeRfProtocolOptions = {},
  ) {}

  private serialize<T>(operation: () => Promise<T>): Promise<T> {
    const task = this.queue.then(operation, operation);
    this.queue = task.catch(() => undefined);
    return task;
  }

  private async vendorIn(request: number, value = 0): Promise<number> {
    const result = await this.current(() =>
      this.device.controlTransferIn(
        {
          requestType: "vendor",
          recipient: "device",
          request,
          value,
          index: 0,
        },
        4,
      ),
    );
    const data = checkIn(result, 4, `vendor request ${request}`);
    return new DataView(data.buffer, data.byteOffset, data.byteLength).getInt32(
      0,
      true,
    );
  }

  private async nios(packet: Uint8Array): Promise<Uint8Array> {
    checkOut(
      await this.current(() =>
        this.device.transferOut(
          PERIPHERAL_ENDPOINT_OUT,
          Uint8Array.from(packet),
        ),
      ),
      NIOS_PACKET_BYTES,
      "NIOS command write",
    );
    return checkIn(
      await this.current(() =>
        this.device.transferIn(PERIPHERAL_ENDPOINT_IN, NIOS_PACKET_BYTES),
      ),
      NIOS_PACKET_BYTES,
      "NIOS command read",
    );
  }

  private async ensureFpga(
    firmware: Omit<BladeRfVersion, "patch">,
    detection: BladeRfDetection,
  ): Promise<BladeRfHostedImage | null> {
    this.checkCurrent();
    if (detection.fpgaConfigured) return null;
    if (this.options.allowVolatileFpgaLoad === false)
      throw new Error(
        `bladeRF ${detection.model} has no configured FPGA. Import the official hosted${detection.model} image, then reconnect.`,
      );
    // Never give a provider the canonical catalog object or the private snapshot.
    const image = Object.freeze({
      ...selectBladeRfImage(detection.model, firmware),
    });
    this.status(
      `Verifying saved official hosted${image.model} ${image.version} image…`,
    );
    const providerDescriptor = { ...image };
    const input = await this.current(() =>
      (this.options.loadImage ?? loadStoredBladeRfImage)(providerDescriptor),
    );
    if (
      Object.keys(image).some(
        (key) =>
          providerDescriptor[key as keyof BladeRfHostedImage] !==
          image[key as keyof BladeRfHostedImage],
      )
    )
      throw new Error(
        "The bladeRF image provider changed the selected official catalog descriptor. The device was not modified.",
      );
    const verifiedBytes = await this.current(() =>
      verifyBladeRfImage(image, input),
    );
    // Detection state can become stale during the provider/hash waits.
    if ((await this.vendorIn(BLADE_USB_CMD_QUERY_FPGA_STATUS)) !== 0)
      throw new Error(
        "bladeRF FPGA state changed before programming; reconnect before retrying.",
      );
    this.status(
      `Loading hosted${image.model} ${image.version} into volatile FPGA RAM…`,
    );
    await this.current(() =>
      this.device.selectAlternateInterface(
        BLADERF_USB_INTERFACE,
        USB_ALT_FPGA_CONFIG,
      ),
    );
    const alternate = this.device.configuration?.interfaces.find(
      (item) => item.interfaceNumber === BLADERF_USB_INTERFACE,
    )?.alternate;
    const configEndpoint = alternate?.endpoints.find(
      (endpoint) =>
        endpoint.endpointNumber === PERIPHERAL_ENDPOINT_OUT &&
        endpoint.direction === "out" &&
        endpoint.type === "bulk",
    );
    if (alternate?.alternateSetting !== USB_ALT_FPGA_CONFIG || !configEndpoint)
      throw new Error(
        "bladeRF FPGA configuration USB descriptor does not expose bulk endpoint 2 OUT. Programming was not started.",
      );
    this.checkCurrent();
    // Dispatch itself may toggle nCONFIG even if the USB promise rejects.
    this.programmingDispatched = true;
    if ((await this.vendorIn(BLADE_USB_CMD_BEGIN_PROG)) !== 0)
      throw new Error("bladeRF firmware rejected volatile FPGA programming.");
    checkOut(
      await this.current(() =>
        this.device.transferOut(
          PERIPHERAL_ENDPOINT_OUT,
          verifiedBytes as Uint8Array<ArrayBuffer>,
        ),
      ),
      verifiedBytes.byteLength,
      "volatile FPGA image write",
    );
    for (let attempt = 0; attempt < 10; attempt += 1) {
      const configured = await this.vendorIn(BLADE_USB_CMD_QUERY_FPGA_STATUS);
      if (configured === 1) {
        this.status(
          "Volatile FPGA image loaded; verifying the hosted profile…",
        );
        return image;
      }
      if (configured !== 0)
        throw new Error(
          `bladeRF FPGA status is invalid after programming: ${configured}.`,
        );
      await this.current(
        () => new Promise((resolve) => setTimeout(resolve, 200)),
      );
    }
    throw new DOMException(
      "bladeRF FPGA did not report configured after the volatile image load.",
      "TimeoutError",
    );
  }

  private rficRead(command: number, channel: number): Promise<bigint> {
    return this.serialize(async () =>
      unpackBladeRfRficResponse(
        await this.nios(packBladeRfRficRequest(false, command, channel)),
        false,
        command,
        channel,
      ),
    );
  }

  private rficWrite(
    command: number,
    channel: number,
    value: bigint,
  ): Promise<void> {
    return this.serialize(async () => {
      unpackBladeRfRficResponse(
        await this.nios(packBladeRfRficRequest(true, command, channel, value)),
        true,
        command,
        channel,
      );
      for (let attempt = 0; attempt < 60; attempt += 1) {
        const status = unpackBladeRfRficResponse(
          await this.nios(
            packBladeRfRficRequest(false, RFIC_STATUS, RFIC_SYSTEM_CHANNEL),
          ),
          false,
          RFIC_STATUS,
          RFIC_SYSTEM_CHANNEL,
        );
        // The RFIC status value is not a command-result bitmap: bit 0 is the
        // initialized state and bits 15:8 are the write-queue length.  The
        // outer NIOS response success flag above is the write result.
        if (((status >> 8n) & 0xffn) === 0n) return;
        await this.current(
          () => new Promise((resolve) => setTimeout(resolve, 1)),
        );
      }
      throw new DOMException(
        "bladeRF RFIC command queue did not drain.",
        "TimeoutError",
      );
    });
  }

  private gpioRead(): Promise<number> {
    return this.serialize(async () =>
      unpackGpioResponse(await this.nios(packGpioRequest(false)), false),
    );
  }

  private gpioWrite(value: number): Promise<void> {
    return this.serialize(async () => {
      unpackGpioResponse(await this.nios(packGpioRequest(true, value)), true);
    });
  }

  async discover(): Promise<BladeRfIdentity> {
    this.checkCurrent();
    if (
      this.device.vendorId !== BLADERF_USB_FILTER.vendorId ||
      this.device.productId !== BLADERF_USB_FILTER.productId
    )
      throw new Error(
        "The selected USB device is not a bladeRF 2.0 Micro (2cf0:5250).",
      );
    const ready = await this.vendorIn(BLADE_USB_CMD_QUERY_DEVICE_READY);
    if (ready !== 1) throw new Error("bladeRF firmware is not ready.");
    const firmwareRaw = await this.current(() =>
      this.device.controlTransferIn(
        {
          requestType: "vendor",
          recipient: "device",
          request: BLADE_USB_CMD_QUERY_VERSION,
          value: 0,
          index: 0,
        },
        4,
      ),
    );
    const firmwareBytes = checkIn(firmwareRaw, 4, "firmware-version query");
    const firmware = {
      major: firmwareBytes[0]! | (firmwareBytes[1]! << 8),
      minor: firmwareBytes[2]! | (firmwareBytes[3]! << 8),
    };
    const detection = await detectBladeRfMicroModel(this.device, firmware, {
      checkCurrent: () => this.checkCurrent(),
    });
    this.checkCurrent();
    const volatileImage = await this.ensureFpga(firmware, detection);
    await this.current(() =>
      this.device.selectAlternateInterface(
        BLADERF_USB_INTERFACE,
        BLADERF_USB_ALT_RF_LINK,
      ),
    );
    const alternate = this.device.configuration?.interfaces.find(
      (item) => item.interfaceNumber === BLADERF_USB_INTERFACE,
    )?.alternate;
    const endpoints = alternate?.endpoints ?? [];
    const sample = endpoints.find(
      (endpoint) =>
        endpoint.endpointNumber === SAMPLE_ENDPOINT_IN &&
        endpoint.direction === "in" &&
        endpoint.type === "bulk",
    );
    const peripheralIn = endpoints.find(
      (endpoint) =>
        endpoint.endpointNumber === PERIPHERAL_ENDPOINT_IN &&
        endpoint.direction === "in" &&
        endpoint.type === "bulk",
    );
    const peripheralOut = endpoints.find(
      (endpoint) =>
        endpoint.endpointNumber === PERIPHERAL_ENDPOINT_OUT &&
        endpoint.direction === "out" &&
        endpoint.type === "bulk",
    );
    if (
      alternate?.alternateSetting !== BLADERF_USB_ALT_RF_LINK ||
      !sample ||
      !peripheralIn ||
      !peripheralOut ||
      ![512, 1024].includes(sample.packetSize)
    )
      throw new Error(
        "bladeRF RF-link USB descriptor does not match the pinned Micro profile.",
      );
    const versionPacket = new Uint8Array(NIOS_PACKET_BYTES);
    versionPacket[0] = 0x43;
    versionPacket[1] = 0x00;
    const versionResponse = await this.serialize(() =>
      this.nios(versionPacket),
    );
    if (
      versionResponse[0] !== 0x43 ||
      versionResponse[1] !== 0 ||
      (versionResponse[2]! & 0x01) !== 0 ||
      versionResponse[4] !== 0 ||
      (versionResponse[2]! & 0x02) === 0
    )
      throw new Error("bladeRF FPGA version query failed.");
    // The public NIOS simulation vectors place major, minor, patch-low,
    // patch-high directly at data offsets 5..8.
    const fpga = {
      major: versionResponse[5]!,
      minor: versionResponse[6]!,
      patch: versionResponse[7]! | (versionResponse[8]! << 8),
    };
    validateProfile(firmware, fpga);
    if (volatileImage && versionText(fpga) !== volatileImage.version)
      throw new Error(
        `bladeRF loaded FPGA version ${versionText(fpga)} differs from verified image ${volatileImage.version}.`,
      );
    // Probe the FPGA RFIC command service before any state-changing command.
    await this.rficRead(RFIC_STATUS, RFIC_SYSTEM_CHANNEL);
    return {
      kind:
        detection.model === "xA4"
          ? "bladerf-2-micro-xa4"
          : detection.model === "xA5"
            ? "bladerf-2-micro-xa5"
            : "bladerf-2-micro-xa9",
      model: detection.model,
      detection: detection.evidence,
      variantValidation: bladeRfModelValidation(detection.model),
      vendorId: 0x2cf0,
      productId: 0x5250,
      serialNumber: this.device.serialNumber ?? null,
      firmware,
      fpga,
      usbPacketSize: sample.packetSize as 512 | 1024,
      volatileImage: volatileImage
        ? {
            model: volatileImage.model,
            version: volatileImage.version,
            sha256: volatileImage.sha256,
          }
        : null,
    };
  }

  async initialize(identity: BladeRfIdentity): Promise<void> {
    const state = await this.rficRead(RFIC_INIT, RFIC_SYSTEM_CHANNEL);
    if (state !== BigInt(RFIC_INIT_ON))
      await this.rficWrite(
        RFIC_INIT,
        RFIC_SYSTEM_CHANNEL,
        BigInt(RFIC_INIT_ON),
      );
    let gpio = await this.gpioRead();
    gpio &= ~(
      GPIO_TIMESTAMP |
      GPIO_PACKET |
      GPIO_8BIT_MODE |
      GPIO_HIGHLY_PACKED_MODE
    );
    gpio =
      identity.usbPacketSize === 512
        ? gpio | GPIO_SMALL_DMA_TRANSFER
        : gpio & ~GPIO_SMALL_DMA_TRANSFER;
    await this.gpioWrite(gpio);
  }

  async configure(
    configuration: BladeRfConfiguration,
  ): Promise<BladeRfSessionDetails> {
    if (
      ![2_400_000, 4_800_000, 9_600_000, 19_200_000].includes(
        configuration.sampleRateHz,
      )
    )
      throw new Error(
        "bladeRF 2.0 Micro supports 2.4, 4.8, 9.6 or experimental 19.2 MS/s in this release.",
      );
    if (
      !Number.isSafeInteger(configuration.centerFrequencyHz) ||
      configuration.centerFrequencyHz < 70_000_000 ||
      configuration.centerFrequencyHz > 6_000_000_000
    )
      throw new Error(
        "bladeRF 2.0 Micro RX frequency must be an integer from 70 MHz to 6 GHz.",
      );
    if (
      !Number.isSafeInteger(configuration.bandwidthHz) ||
      configuration.bandwidthHz < 200_000 ||
      configuration.bandwidthHz > 56_000_000
    )
      throw new Error(
        "bladeRF 2.0 Micro analog bandwidth must be 200 kHz–56 MHz.",
      );
    const settings = validateBladeRfRxSettings(
      configuration.rxSettings ?? DEFAULT_BLADERF_RX_SETTINGS,
      configuration.centerFrequencyHz,
    );
    this.rxChannel = settings.rxInput === "RX1" ? 0 : 2;
    await this.rficWrite(
      RFIC_SAMPLE_RATE,
      this.rxChannel,
      BigInt(configuration.sampleRateHz),
    );
    await this.rficWrite(
      RFIC_BANDWIDTH,
      this.rxChannel,
      BigInt(configuration.bandwidthHz),
    );
    await this.rficWrite(
      RFIC_FREQUENCY,
      this.rxChannel,
      BigInt(configuration.centerFrequencyHz),
    );
    const actualRate = Number(
      await this.rficRead(RFIC_SAMPLE_RATE, this.rxChannel),
    );
    const actualBandwidth = Number(
      await this.rficRead(RFIC_BANDWIDTH, this.rxChannel),
    );
    const actualCenter = Number(
      await this.rficRead(RFIC_FREQUENCY, this.rxChannel),
    );
    const rateError = Math.abs(actualRate - configuration.sampleRateHz);
    const centerError = Math.abs(
      actualCenter - configuration.centerFrequencyHz,
    );
    const maximumRateError = Math.max(100, configuration.sampleRateHz * 0.001);
    if (
      !Number.isSafeInteger(actualRate) ||
      actualRate <= 0 ||
      rateError > maximumRateError ||
      !Number.isSafeInteger(actualCenter) ||
      centerError > 100 ||
      !Number.isSafeInteger(actualBandwidth) ||
      actualBandwidth < 200_000 ||
      actualBandwidth > 56_000_000
    ) {
      throw new Error(
        `bladeRF RX readback is outside the accepted tolerance: requested rate ${configuration.sampleRateHz}, read ${actualRate}; requested center ${configuration.centerFrequencyHz}, read ${actualCenter}; bandwidth ${actualBandwidth}.`,
      );
    }
    const gainRange = bladeRfGainRange(actualCenter);
    if (
      settings.manualGainDb < gainRange.min ||
      settings.manualGainDb > gainRange.max
    )
      throw new Error(
        "bladeRF accepted frequency requires a different manual gain range.",
      );
    await this.rficWrite(
      RFIC_GAIN_MODE,
      this.rxChannel,
      BigInt(BLADERF_GAIN_MODES[settings.gainMode].code),
    );
    const modeReadback = await this.rficRead(RFIC_GAIN_MODE, this.rxChannel);
    if (modeReadback !== BigInt(BLADERF_GAIN_MODES[settings.gainMode].code))
      throw new Error(
        "bladeRF gain mode readback did not match the requested mode.",
      );
    let acceptedGainDb: number | null = null;
    if (settings.gainMode === "manual") {
      const rawGain = settings.manualGainDb - gainRange.offset;
      // The gain output register can retain its old value while ENSM/RX is off.
      // Enable only the chosen RF chain (USB streaming remains stopped), verify
      // its settled gain, then return to the configured/stopped state.
      for (const channel of RFIC_RX_CHANNELS)
        await this.rficWrite(RFIC_ENABLE, channel, 0n);
      try {
        await this.rficWrite(RFIC_ENABLE, this.rxChannel, 1n);
        await this.rficWrite(
          RFIC_GAIN,
          this.rxChannel,
          BigInt.asUintN(64, BigInt(rawGain)),
        );
        for (let attempt = 0; attempt < 20; attempt++) {
          // FPGA gain handlers return the signed RFIC value in the low 32 bits.
          acceptedGainDb =
            Number(
              BigInt.asIntN(32, await this.rficRead(RFIC_GAIN, this.rxChannel)),
            ) + gainRange.offset;
          if (acceptedGainDb === settings.manualGainDb) break;
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
        if (acceptedGainDb !== settings.manualGainDb)
          throw new Error(
            `bladeRF gain readback ${acceptedGainDb} dB differs from requested ${settings.manualGainDb} dB.`,
          );
      } finally {
        await this.rficWrite(RFIC_ENABLE, this.rxChannel, 0n);
      }
    }
    const identity = this.identity;
    if (!identity)
      throw new Error("Discover the bladeRF before configuring it.");
    return {
      protocolProfile: bladeRfProtocolProfile(identity.model),
      referenceCommit: BLADERF_REFERENCE_COMMIT,
      identity,
      nativeEncoding: "ci16_le_sc11",
      nativeSampleRateHz: configuration.sampleRateHz,
      acceptedSampleRateHz: actualRate,
      effectiveSampleRateHz:
        configuration.sampleRateHz >= 4_800_000
          ? 2_400_000
          : configuration.sampleRateHz,
      requestedCenterFrequencyHz: configuration.centerFrequencyHz,
      acceptedCenterFrequencyHz: actualCenter,
      requestedBandwidthHz: configuration.bandwidthHz,
      acceptedBandwidthHz: actualBandwidth,
      gainMode: settings.gainMode,
      rxInput: settings.rxInput,
      rxSettings: settings,
      requestedGainDb:
        settings.gainMode === "manual" ? settings.manualGainDb : null,
      acceptedGainDb,
      hardwareValidation: "pending",
    };
  }

  identity?: BladeRfIdentity;
  async open(): Promise<BladeRfIdentity> {
    this.identity = undefined;
    this.programmingDispatched = false;
    try {
      const identity = await this.discover();
      this.checkCurrent();
      await this.initialize(identity);
      this.checkCurrent();
      this.identity = identity;
      return identity;
    } catch (error) {
      if (this.programmingDispatched) {
        const message = `${error instanceof Error ? error.message : String(error)} Volatile FPGA state may have changed; reconnect or power-cycle before retrying. No rollback was performed.`;
        if (error instanceof DOMException)
          throw new DOMException(message, error.name);
        throw new Error(message, { cause: error });
      }
      throw error;
    }
  }

  async setRxEnabled(enabled: boolean): Promise<void> {
    // Keep exactly one RX chain enabled. Physical RX2 is BLADERF_CHANNEL_RX(1)=2.
    // Never address the odd-numbered TX channels.
    for (const channel of RFIC_RX_CHANNELS)
      if (!enabled || channel !== this.rxChannel)
        await this.rficWrite(RFIC_ENABLE, channel, 0n);
    if (enabled) await this.rficWrite(RFIC_ENABLE, this.rxChannel, 1n);
    for (const channel of RFIC_RX_CHANNELS) {
      const expected = enabled && channel === this.rxChannel ? 1n : 0n;
      if ((await this.rficRead(RFIC_ENABLE, channel)) !== expected)
        throw new Error("bladeRF RX input enable readback did not match.");
    }
    const result = await this.vendorIn(BLADE_USB_CMD_RF_RX, enabled ? 1 : 0);
    if (result !== 0 && result !== 0x44)
      throw new Error(
        `bladeRF firmware rejected RX ${enabled ? "start" : "stop"} with code ${result}.`,
      );
  }
}

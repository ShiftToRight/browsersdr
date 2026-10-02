import type {
  BladeRfFirmwareVersion,
  BladeRfMicroModel,
} from "./bladerfModels";

/** Source: Nuand/bladeRF 35174c30b009cdb335800c411f3c14d45283f12b.
 * Read the firmware cache through EP0 without selecting the SPI alternate,
 * whose initialization can change flash protection. No interface ownership or
 * cleanup is performed here; the stopped discovery connection owns those.
 */
const CALIBRATION_BYTES = 256;
const CACHE_READ_BYTES = 64;
const QUERY_FPGA_STATUS = 1;
const QUERY_FLASH_ID = 7;
const READ_CAL_CACHE = 110;

export interface BladeRfDetectionEvidence {
  source: "firmware-calibration-cache";
  calibrationField: "B";
  calibrationValue: "A4" | "A5" | "A9";
  calibrationCrc16: number;
  calibrationRecordOffset: number;
  flash: {
    manufacturerId: number;
    deviceId: number;
    pageBytes: 256;
    eraseBlockBytes: 65536;
    totalBytes: number;
  };
  temperatureGrade: "unknown";
}

export interface BladeRfDetection {
  model: BladeRfMicroModel;
  fpgaConfigured: boolean;
  evidence: BladeRfDetectionEvidence;
}

type CalibrationIdentity = Pick<
  BladeRfDetectionEvidence,
  "calibrationValue" | "calibrationCrc16" | "calibrationRecordOffset"
> & { model: BladeRfMicroModel };

function calibrationError(detail: string): Error {
  return new Error(`bladeRF calibration identity is invalid: ${detail}.`);
}

/** CRC-16/XMODEM: upstream zcrc, initial 0, polynomial 0x1021. */
function crc16(page: Uint8Array, start: number, end: number): number {
  let crc = 0;
  for (let offset = start; offset < end; offset += 1) {
    crc ^= page[offset]! << 8;
    for (let bit = 0; bit < 8; bit += 1)
      crc = ((crc << 1) ^ (crc & 0x8000 ? 0x1021 : 0)) & 0xffff;
  }
  return crc;
}

export function parseBladeRfCalibration(page: Uint8Array): CalibrationIdentity {
  if (!(page instanceof Uint8Array) || page.byteLength !== CALIBRATION_BYTES)
    throw calibrationError("expected exactly 256 bytes");

  let identity: CalibrationIdentity | undefined;
  let offset = 0;
  while (offset < CALIBRATION_BYTES) {
    const length = page[offset]!;
    if (length === 0xff) {
      for (let tail = offset; tail < CALIBRATION_BYTES; tail += 1)
        if (page[tail] !== 0xff)
          throw calibrationError("non-erased bytes after the terminator");
      break;
    }
    const end = offset + length + 3;
    if (length < 1 || end > CALIBRATION_BYTES)
      throw calibrationError("record length exceeds page bounds or is zero");
    const checksumOffset = offset + length + 1;
    const checksum = page[checksumOffset]! | (page[checksumOffset + 1]! << 8);
    if (crc16(page, offset, checksumOffset) !== checksum)
      throw calibrationError(`CRC mismatch at record ${offset}`);

    if (page[offset + 1] === 0x42) {
      if (identity) throw calibrationError("duplicate B records");
      if (length !== 3 || page[offset + 2] !== 0x41)
        throw calibrationError("B must contain exactly A4, A5 or A9");
      const variant = page[offset + 3];
      if (variant !== 0x34 && variant !== 0x35 && variant !== 0x39)
        throw calibrationError("unsupported B value");
      const calibrationValue =
        variant === 0x34 ? "A4" : variant === 0x35 ? "A5" : "A9";
      identity = {
        model:
          calibrationValue === "A4"
            ? "xA4"
            : calibrationValue === "A5"
              ? "xA5"
              : "xA9",
        calibrationValue,
        calibrationCrc16: checksum,
        calibrationRecordOffset: offset,
      };
    }
    offset = end;
  }
  if (!identity) throw calibrationError("missing B record");
  return identity;
}

function requireSupportedFirmware(firmware: BladeRfFirmwareVersion): void {
  if (
    !firmware ||
    ![firmware.major, firmware.minor].every(
      (part) => Number.isInteger(part) && part >= 0 && part <= 0xffff,
    ) ||
    firmware.major !== 2 ||
    firmware.minor < 4
  )
    throw new Error(
      "bladeRF model detection requires supported firmware major 2, minor 4 or later.",
    );
}

function requireDiscoveryConnection(device: USBDevice): void {
  const configuration = device.configuration;
  const iface = configuration?.interfaces.find(
    (entry) => entry.interfaceNumber === 0,
  ) as (USBInterface & { readonly claimed?: boolean }) | undefined;
  if (
    !device.opened ||
    configuration?.configurationValue !== 1 ||
    !iface?.claimed
  )
    throw new Error(
      "bladeRF detection requires an open configuration 1 connection with interface 0 claimed.",
    );
}

function parseFpgaStatus(view: DataView): boolean {
  const status = view.getInt32(0, true);
  if (status !== 0 && status !== 1)
    throw new Error(`bladeRF FPGA status is invalid: ${status}.`);
  return status === 1;
}

function parseFlashId(view: DataView): BladeRfDetectionEvidence["flash"] {
  const id = view.getUint32(0, true);
  const manufacturerId = (id >>> 8) & 0xff;
  const deviceId = id & 0xff;
  let totalBytes: number | undefined;
  if (manufacturerId === 0xc2 && deviceId === 0x36) totalBytes = 4_194_304;
  if (manufacturerId === 0x1f && deviceId === 0x47) totalBytes = 4_194_304;
  if (manufacturerId === 0xef) {
    if (deviceId === 0x15) totalBytes = 4_194_304;
    if (deviceId === 0x16) totalBytes = 8_388_608;
    if (deviceId === 0x17) totalBytes = 16_777_216;
  }
  if (id >>> 16 || totalBytes === undefined)
    throw new Error("bladeRF flash architecture is invalid or unsupported.");
  return {
    manufacturerId,
    deviceId,
    pageBytes: 256,
    eraseBlockBytes: 65536,
    totalBytes,
  };
}

/** Call only after firmware readiness/version reads on a stopped connection.
 * checkCurrent must validate this discovery generation; its cancellation error
 * is preserved. The caller releases/closes its own connection on failure.
 */
export async function detectBladeRfMicroModel(
  device: USBDevice,
  firmware: BladeRfFirmwareVersion,
  options: { checkCurrent?: () => void } = {},
): Promise<BladeRfDetection> {
  const checkCurrent = options.checkCurrent;
  checkCurrent?.();
  requireSupportedFirmware(firmware);
  requireDiscoveryConnection(device);

  async function read(
    request: number,
    index: number,
    length: number,
  ): Promise<DataView> {
    checkCurrent?.();
    requireDiscoveryConnection(device);
    let result: USBInTransferResult;
    try {
      result = await device.controlTransferIn(
        {
          requestType: "vendor",
          recipient: "device",
          request,
          value: 0,
          index,
        },
        length,
      );
    } finally {
      // Also preserve cancellation if the USB promise rejects during disconnect.
      checkCurrent?.();
    }
    requireDiscoveryConnection(device);
    if (result.status !== "ok" || result.data?.byteLength !== length)
      throw new DOMException(
        `bladeRF detection request ${request} returned ${result.status} with ${result.data?.byteLength ?? 0}/${length} bytes.`,
        "NetworkError",
      );
    return result.data;
  }

  const fpgaConfigured = parseFpgaStatus(await read(QUERY_FPGA_STATUS, 0, 4));
  const flash = parseFlashId(await read(QUERY_FLASH_ID, 0, 4));
  const page = new Uint8Array(CALIBRATION_BYTES);
  for (let offset = 0; offset < CALIBRATION_BYTES; offset += CACHE_READ_BYTES) {
    const view = await read(READ_CAL_CACHE, offset, CACHE_READ_BYTES);
    page.set(
      new Uint8Array(view.buffer, view.byteOffset, view.byteLength),
      offset,
    );
  }
  const { model, ...calibration } = parseBladeRfCalibration(page);
  if (parseFpgaStatus(await read(QUERY_FPGA_STATUS, 0, 4)) !== fpgaConfigured)
    throw new Error(
      "bladeRF FPGA state changed during model detection; reconnect before retrying.",
    );
  return {
    model,
    fpgaConfigured,
    evidence: {
      source: "firmware-calibration-cache",
      calibrationField: "B",
      ...calibration,
      flash,
      temperatureGrade: "unknown",
    },
  };
}

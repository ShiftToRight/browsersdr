import {
  USRP_B205_IMAGE,
  verifyUsrpB205Member,
  type VerifiedUsrpB205Image,
} from "./usrpB205Images";
import {
  parseUsrpB205Firmware,
  USRP_B205_FIRMWARE,
  verifyUsrpB205FirmwareImport,
  type UsrpB205FirmwareWrite,
  type VerifiedUsrpB205Firmware,
} from "./usrpB205Firmware";

export const USRP_B205_USB_FILTER = {
  vendorId: 0x2500,
  productId: 0x0022,
} as const;
export const USRP_B205_CLAIM_ORDER = [4, 3, 2] as const;
export const USRP_B205_RELEASE_ORDER = [2, 3, 4] as const;

export const USRP_B205_FX3_REQUESTS = Object.freeze({
  firmwareRamWrite: {
    direction: "out",
    request: 0xa0,
    minimumLength: 0,
    maximumLength: 255,
  },
  firmwareCompatibility: { direction: "in", request: 0x15, length: 2 },
  usbSpeed: { direction: "in", request: 0x80, length: 1 },
  loaderState: { direction: "in", request: 0x83, length: 1 },
  fpgaHashRead: { direction: "in", request: 0x1d, length: 4 },
  fpgaHashWrite: { direction: "out", request: 0x1c, length: 4 },
  preflight: { direction: "in", request: 0x22, length: 512 },
  prepare: { direction: "out", request: 0x55, length: 1 },
  configure: { direction: "out", request: 0x02, length: 1 },
  imageChunk: {
    direction: "out",
    request: 0x12,
    minimumLength: 1,
    maximumLength: 512,
  },
  gpifReset: { direction: "out", request: 0x72, length: 4 },
} as const);

const INPUT_REQUESTS = new Map<number, number>([
  [0x15, 2],
  [0x80, 1],
  [0x83, 1],
  [0x1d, 4],
  [0x22, 512],
]);
const OUTPUT_REQUESTS = new Map<number, { minimum: number; maximum: number }>([
  [0x1c, { minimum: 4, maximum: 4 }],
  [0x55, { minimum: 1, maximum: 1 }],
  [0x02, { minimum: 1, maximum: 1 }],
  [0x12, { minimum: 1, maximum: 512 }],
  [0x72, { minimum: 4, maximum: 4 }],
]);

export type UsrpB205Fx3State = 0 | 1 | 2 | 3 | 4 | 5 | 6;
export interface UsrpB205Fx3Identity {
  readonly kind: "usrp-b205-mini-fx3";
  readonly vendorId: 0x2500;
  readonly productId: 0x0022;
  readonly productName: string;
  readonly serialNumber: string | null;
  readonly descriptorLayoutVerified: true;
  readonly firmware: { major: 8; minor: number };
  readonly usbSpeed: 3;
  readonly loaderState: 4;
  readonly fpgaLegacyHash: 0x1624155e;
  readonly imageSha256: typeof USRP_B205_IMAGE.memberSha256;
  readonly imageDisposition: "already-compatible" | "loaded-volatile";
  readonly claimedInterfaces: readonly [4, 3, 2];
  /** Signature/7.x is behind CHDR control and is intentionally deferred. */
  readonly fpgaCompatibilityCheck: "pending-chdr-step-04";
}

export interface UsrpB205Fx3Diagnostics {
  readonly state:
    "idle" | "opening" | "ready" | "closing" | "cleanup-required" | "closed";
  readonly lastLoaderState: UsrpB205Fx3State | null;
  readonly mutationStarted: boolean;
  readonly firmwareDisposition: "runtime-present" | "loaded-volatile" | null;
  readonly firmwareWrites: number;
  readonly powerCycleRequired: boolean;
  readonly claimedInterfaces: readonly number[];
  readonly cleanupErrors: readonly string[];
}

export interface UsrpB205Fx3Options {
  verifyImage?(image: VerifiedUsrpB205Image): Promise<Uint8Array>;
  verifyFirmware?(
    firmware: VerifiedUsrpB205Firmware,
  ): Promise<readonly UsrpB205FirmwareWrite[]>;
  pause?(milliseconds: number): Promise<void>;
  ep0TimeoutMs?: number;
  imageChunkTimeoutMs?: number;
}

/** Endpoint-bound handoff for later steps; endpoint 2 OUT is unrepresentable. */
export interface UsrpB205ClaimedBulkIo {
  transferControlOut(data: BufferSource): Promise<USBOutTransferResult>;
  transferControlIn(length: number): Promise<USBInTransferResult>;
  transferRxIn(length: number): Promise<USBInTransferResult>;
  clearRxHalt(): Promise<void>;
}

const abortError = () =>
  new DOMException("USRP B205-mini connection was cancelled.", "AbortError");
const invalidState = (message: string) =>
  new DOMException(message, "InvalidStateError");

function bytes(view: DataView | null | undefined): Uint8Array {
  return view
    ? new Uint8Array(view.buffer, view.byteOffset, view.byteLength)
    : new Uint8Array();
}

function setup(request: number): USBControlTransferParameters {
  return {
    requestType: "vendor",
    recipient: "device",
    request,
    value: 0,
    index: 0,
  };
}

function printable(value: string): boolean {
  return /^[\x20-\x7e]{1,128}$/.test(value);
}

function descriptor(device: USBDevice): USBConfiguration {
  const configurations =
    device.configurations ??
    (device.configuration ? [device.configuration] : []);
  if (
    configurations.length !== 1 ||
    configurations[0]?.configurationValue !== 1
  ) {
    throw new Error("USRP B205-mini requires exactly USB configuration 1.");
  }
  const configuration = device.configuration ?? configurations[0]!;
  if (
    configuration.configurationValue !== 1 ||
    configuration.interfaces.length !== 5
  ) {
    const numbers =
      configuration.interfaces.map((item) => item.interfaceNumber).join(", ") ||
      "none";
    throw new Error(
      `USRP B205-mini USB configuration must expose interfaces 0 through 4; Chrome reported ${configuration.interfaces.length} interface(s): ${numbers}.`,
    );
  }
  const expected = new Map<number, readonly [number, "in" | "out"] | null>([
    [0, null],
    [1, [2, "out"]],
    [2, [6, "in"]],
    [3, [4, "out"]],
    [4, [8, "in"]],
  ]);
  for (const [number, endpoint] of expected) {
    const item = configuration.interfaces.find(
      (candidate: USBInterface) => candidate.interfaceNumber === number,
    );
    const alternates = item?.alternates?.length
      ? item.alternates
      : item
        ? [item.alternate]
        : [];
    const alternate = alternates.find(
      (candidate: USBAlternateInterface) => candidate.alternateSetting === 0,
    );
    if (
      !item ||
      alternates.length !== 1 ||
      !alternate ||
      alternate.interfaceClass !== 0xff ||
      alternate.endpoints.length !== (endpoint ? 1 : 0)
    ) {
      throw new Error(
        `USRP B205-mini USB interface ${number} descriptor does not match the pinned profile.`,
      );
    }
    if (endpoint) {
      const [endpointNumber, direction] = endpoint;
      const actual = alternate.endpoints[0]!;
      if (
        actual.endpointNumber !== endpointNumber ||
        actual.direction !== direction ||
        actual.type !== "bulk" ||
        actual.packetSize !== 1024
      ) {
        throw new Error(
          `USRP B205-mini USB interface ${number} endpoint does not match the SuperSpeed profile.`,
        );
      }
    }
  }
  return configuration;
}

function bootloaderDescriptor(device: USBDevice): boolean {
  const configurations =
    device.configurations ??
    (device.configuration ? [device.configuration] : []);
  if (
    configurations.length !== 1 ||
    configurations[0]?.configurationValue !== 1
  )
    return false;
  const configuration = device.configuration ?? configurations[0];
  const item =
    configuration?.interfaces.length === 1
      ? configuration.interfaces[0]
      : undefined;
  const alternates = item?.alternates?.length
    ? item.alternates
    : item
      ? [item.alternate]
      : [];
  // Cypress bootloader product strings vary by firmware/Chrome platform
  // (for example "WestBridge" versus "Cypress WestBridge"). The pinned
  // VID:PID and its unique one-interface, endpoint-free layout are the stable
  // discriminator; runtime firmware always exposes the five-interface B2xx
  // layout validated below.
  return (
    item?.interfaceNumber === 0 &&
    alternates.length === 1 &&
    alternates[0]?.interfaceClass === 0xff &&
    alternates[0].endpoints.length === 0
  );
}

export function runtimeDescriptorAvailable(device: USBDevice): boolean {
  const configuration = device.configurations?.find(
    (value) => value.configurationValue === 1,
  );
  return configuration?.interfaces.length === 5;
}

/** Resolve an authorized B205 across unplug/replug and FX3 re-enumeration.
 * The initiating page may still hold the previous USB object and serial, so a
 * sole current identity is authoritative. Multiple unmatched radios remain
 * deliberately ambiguous. */
export function selectAuthorizedUsrpB205Device(
  devices: readonly USBDevice[],
  previousSerial: string | null,
): USBDevice | undefined {
  const candidates = devices.filter(
    (device) =>
      device.vendorId === USRP_B205_USB_FILTER.vendorId &&
      device.productId === USRP_B205_USB_FILTER.productId,
  );
  const serialMatches =
    previousSerial === null
      ? []
      : candidates.filter((device) => device.serialNumber === previousSerial);
  if (serialMatches.length === 1) return serialMatches[0];
  const runtimes = candidates.filter(runtimeDescriptorAvailable);
  if (runtimes.length === 1) return runtimes[0];
  return candidates.length === 1 ? candidates[0] : undefined;
}

async function defaultVerifyImage(
  image: VerifiedUsrpB205Image,
): Promise<Uint8Array> {
  if (
    image.contract.memberSha256 !== USRP_B205_IMAGE.memberSha256 ||
    image.contract.memberByteLength !== USRP_B205_IMAGE.memberByteLength ||
    image.memberSha256 !== USRP_B205_IMAGE.memberSha256 ||
    image.legacyHash !== USRP_B205_IMAGE.legacyHash
  ) {
    throw new Error(
      "USRP B205-mini loader received image metadata outside the pinned profile.",
    );
  }
  return verifyUsrpB205Member(image.bytes);
}

async function defaultVerifyFirmware(
  firmware: VerifiedUsrpB205Firmware,
): Promise<readonly UsrpB205FirmwareWrite[]> {
  if (
    firmware.contract.memberSha256 !== USRP_B205_FIRMWARE.memberSha256 ||
    firmware.memberSha256 !== USRP_B205_FIRMWARE.memberSha256
  ) {
    throw new Error(
      "USRP FX3 loader received firmware outside the pinned profile.",
    );
  }
  const verified = await verifyUsrpB205FirmwareImport(
    USRP_B205_FIRMWARE.memberFilename,
    new TextEncoder().encode(firmware.text),
  );
  return parseUsrpB205Firmware(verified.text);
}

export class UsrpB205Fx3Connection {
  private device?: USBDevice;
  private permission?: Promise<USBDevice>;
  private operation?: Promise<UsrpB205Fx3Identity>;
  private closeTask?: Promise<void>;
  private openPromise?: Promise<void>;
  private claimed = new Set<number>();
  private token = 0;
  private terminal = false;
  private diagnosticsValue: UsrpB205Fx3Diagnostics = {
    state: "idle",
    lastLoaderState: null,
    mutationStarted: false,
    firmwareDisposition: null,
    firmwareWrites: 0,
    powerCycleRequired: false,
    claimedInterfaces: [],
    cleanupErrors: [],
  };

  constructor(private readonly options: UsrpB205Fx3Options = {}) {}

  get diagnostics(): UsrpB205Fx3Diagnostics {
    return {
      ...this.diagnosticsValue,
      claimedInterfaces: [...this.claimed],
      cleanupErrors: [...this.diagnosticsValue.cleanupErrors],
    };
  }

  claimedBulkIo(): UsrpB205ClaimedBulkIo {
    if (this.diagnosticsValue.state !== "ready" || !this.device)
      throw invalidState(
        "USRP B205-mini bulk I/O is unavailable until FX3 discovery completes.",
      );
    const device = this.device;
    return {
      transferControlOut: (data) => device.transferOut(4, data),
      transferControlIn: (length) => device.transferIn(8, length),
      transferRxIn: (length) => device.transferIn(6, length),
      clearRxHalt: () =>
        device.clearHalt
          ? device.clearHalt("in", 6)
          : Promise.reject(
              new Error(
                "WebUSB clearHalt is unavailable for USRP B205-mini endpoint 6.",
              ),
            ),
    };
  }

  /** Calls requestDevice before any await so transient user activation is preserved. */
  requestAndOpen(
    image: VerifiedUsrpB205Image,
    usb: USB | undefined = navigator.usb,
    firmware?: VerifiedUsrpB205Firmware,
  ): Promise<UsrpB205Fx3Identity> {
    if (!usb)
      return Promise.reject(
        new DOMException(
          "WebUSB is unavailable; use HTTPS or localhost in a compatible browser.",
          "RadioError.NoUsbSupport",
        ),
      );
    if (this.operation || this.device || this.terminal)
      return Promise.reject(
        invalidState("USRP B205-mini already has a connection owner."),
      );
    let requested: Promise<USBDevice>;
    try {
      requested = usb.requestDevice({ filters: [{ ...USRP_B205_USB_FILTER }] });
    } catch (error) {
      return Promise.reject(error);
    }
    this.permission = requested.then((device) => {
      this.device = device;
      return device;
    });
    return this.begin(this.permission, image, firmware, usb);
  }

  open(
    device: USBDevice,
    image: VerifiedUsrpB205Image,
    firmware?: VerifiedUsrpB205Firmware,
    usb?: Pick<USB, "getDevices">,
  ): Promise<UsrpB205Fx3Identity> {
    if (
      this.operation ||
      (this.device && this.device !== device) ||
      this.terminal
    )
      return Promise.reject(
        invalidState("USRP B205-mini already has a connection owner."),
      );
    this.device = device;
    return this.begin(Promise.resolve(device), image, firmware, usb);
  }

  private begin(
    device: Promise<USBDevice>,
    image: VerifiedUsrpB205Image,
    firmware?: VerifiedUsrpB205Firmware,
    usb?: Pick<USB, "getDevices">,
  ): Promise<UsrpB205Fx3Identity> {
    const token = ++this.token;
    this.diagnosticsValue = { ...this.diagnosticsValue, state: "opening" };
    const task = this.initialize(device, image, token, firmware, usb).catch(
      async (error: unknown) => {
        const powerCycleRequired = this.diagnosticsValue.powerCycleRequired;
        try {
          await this.cleanup();
        } catch {
          /* Retryable cleanup-required is retained. */
        }
        if (powerCycleRequired) {
          const message =
            error instanceof Error ? error.message : String(error);
          throw new Error(
            `${message} The volatile FPGA load was interrupted after mutation began; physically power-cycle the USB device before retrying.`,
            { cause: error },
          );
        }
        throw error;
      },
    );
    this.operation = task;
    return task;
  }

  private async loadRuntimeFirmware(
    token: number,
    bootloader: USBDevice,
    firmware: VerifiedUsrpB205Firmware,
    usb: Pick<USB, "getDevices">,
  ): Promise<USBDevice> {
    const records = await (
      this.options.verifyFirmware ?? defaultVerifyFirmware
    )(firmware);
    this.guard(token);
    let writes = 0;
    for (const record of records) {
      this.guard(token);
      const setupValue: USBControlTransferParameters = {
        requestType: "vendor",
        recipient: "device",
        request: 0xa0,
        value: record.address & 0xffff,
        index: Math.floor(record.address / 0x1_0000) & 0xffff,
      };
      const result = await this.deadline(
        bootloader.controlTransferOut(
          setupValue,
          Uint8Array.from(record.bytes),
        ),
        this.options.imageChunkTimeoutMs ?? 5_000,
        `firmware RAM write 0x${record.address.toString(16)}`,
      );
      if (
        result.status !== "ok" ||
        result.bytesWritten !== record.bytes.byteLength
      ) {
        throw new DOMException(
          `USRP FX3 firmware RAM write returned ${result.status} with ${result.bytesWritten}/${record.bytes.byteLength} bytes.`,
          "NetworkError",
        );
      }
      writes++;
      this.diagnosticsValue = {
        ...this.diagnosticsValue,
        firmwareWrites: writes,
      };
    }
    this.diagnosticsValue = {
      ...this.diagnosticsValue,
      firmwareDisposition: "loaded-volatile",
    };
    try {
      await bootloader.close();
    } catch {
      /* Re-enumeration commonly invalidates the old handle. */
    }
    const serial = bootloader.serialNumber;
    for (let attempt = 0; attempt < 100; attempt += 1) {
      await this.pause(token, 50);
      const candidates = (await usb.getDevices!()).filter(
        (candidate) =>
          candidate.vendorId === USRP_B205_USB_FILTER.vendorId &&
          candidate.productId === USRP_B205_USB_FILTER.productId &&
          runtimeDescriptorAvailable(candidate),
      );
      // The Cypress bootloader serial and UHD runtime serial are not the same
      // identity on physical B205-mini hardware. Prefer an exact match when a
      // platform preserves it, but accept the sole authorized runtime device.
      // Multiple unmatched runtimes remain ambiguous and are never guessed.
      const serialMatches =
        serial === null
          ? []
          : candidates.filter((candidate) => candidate.serialNumber === serial);
      const runtime =
        serialMatches.length === 1
          ? serialMatches[0]
          : candidates.length === 1
            ? candidates[0]
            : undefined;
      if (runtime) {
        this.device = runtime;
        this.openPromise = undefined;
        return runtime;
      }
      if (candidates.length > 1)
        throw new Error(
          "Multiple authorized B205-mini runtime devices appeared after firmware loading; reconnect the intended radio explicitly.",
        );
    }
    throw new DOMException(
      "The FX3 firmware loaded, but Chromium did not expose the re-enumerated B205-mini runtime device. Click Connect again to grant the runtime identity.",
      "NotFoundError",
    );
  }

  private guard(token: number): void {
    if (token !== this.token || this.terminal || this.closeTask)
      throw abortError();
  }

  private deadline<T>(
    promise: Promise<T>,
    milliseconds: number,
    operation: string,
  ): Promise<T> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(
        () =>
          reject(
            new DOMException(
              `USRP B205-mini ${operation} timed out.`,
              "TimeoutError",
            ),
          ),
        milliseconds,
      );
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

  private async controlIn(
    token: number,
    request: number,
    length: number,
  ): Promise<Uint8Array> {
    if (INPUT_REQUESTS.get(request) !== length)
      throw new Error(
        `Forbidden USRP B205-mini control IN request 0x${request.toString(16)}.`,
      );
    this.guard(token);
    const result = await this.deadline(
      this.device!.controlTransferIn(setup(request), length),
      this.options.ep0TimeoutMs ?? 1_000,
      `control IN 0x${request.toString(16)}`,
    );
    this.guard(token);
    const value = bytes(result.data);
    if (result.status !== "ok" || value.byteLength !== length) {
      throw new DOMException(
        `USRP B205-mini control IN 0x${request.toString(16)} returned ${result.status} with ${value.byteLength}/${length} bytes.`,
        "NetworkError",
      );
    }
    return Uint8Array.from(value);
  }

  private async controlOut(
    token: number,
    request: number,
    data: Uint8Array,
  ): Promise<void> {
    const allowed = OUTPUT_REQUESTS.get(request);
    if (
      !allowed ||
      data.byteLength < allowed.minimum ||
      data.byteLength > allowed.maximum
    ) {
      throw new Error(
        `Forbidden USRP B205-mini control OUT request 0x${request.toString(16)} or payload length.`,
      );
    }
    this.guard(token);
    const timeout =
      request === 0x12
        ? (this.options.imageChunkTimeoutMs ?? 5_000)
        : (this.options.ep0TimeoutMs ?? 1_000);
    const result = await this.deadline(
      this.device!.controlTransferOut(setup(request), Uint8Array.from(data)),
      timeout,
      `control OUT 0x${request.toString(16)}`,
    );
    this.guard(token);
    if (result.status !== "ok" || result.bytesWritten !== data.byteLength) {
      throw new DOMException(
        `USRP B205-mini control OUT 0x${request.toString(16)} returned ${result.status} with ${result.bytesWritten}/${data.byteLength} bytes.`,
        "NetworkError",
      );
    }
  }

  private async state(token: number): Promise<UsrpB205Fx3State> {
    const state = (await this.controlIn(token, 0x83, 1))[0]!;
    if (!Number.isInteger(state) || state < 0 || state > 6)
      throw new Error(
        `USRP B205-mini returned unknown FPGA loader state ${state}.`,
      );
    this.diagnosticsValue = {
      ...this.diagnosticsValue,
      lastLoaderState: state as UsrpB205Fx3State,
    };
    return state as UsrpB205Fx3State;
  }

  private async hash(token: number): Promise<number> {
    const value = await this.controlIn(token, 0x1d, 4);
    return new DataView(
      value.buffer,
      value.byteOffset,
      value.byteLength,
    ).getUint32(0, true);
  }

  private async pause(token: number, milliseconds: number): Promise<void> {
    await (this.options.pause?.(milliseconds) ??
      new Promise<void>((resolve) => setTimeout(resolve, milliseconds)));
    this.guard(token);
  }

  private async pollState(
    token: number,
    target: UsrpB205Fx3State,
    attempts: number,
    phase: string,
  ): Promise<void> {
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      const current = await this.state(token);
      if (current === target) return;
      if (current === 5 || current === 6)
        throw new Error(
          `USRP B205-mini FPGA ${phase} failed in loader state ${current}; a physical USB power cycle is required.`,
        );
      await this.pause(token, 10);
    }
    throw new DOMException(
      `USRP B205-mini FPGA ${phase} did not reach state ${target}.`,
      "TimeoutError",
    );
  }

  private async initialLoaderState(token: number): Promise<UsrpB205Fx3State> {
    let current = await this.state(token);
    if (current === 3) {
      for (let attempt = 0; attempt < 100; attempt += 1) {
        await this.pause(token, 10);
        current = await this.state(token);
        if (current === 4) return current;
        if (current !== 3) {
          throw new Error(
            `USRP B205-mini FPGA loader left busy state for unsafe state ${current}; physically power-cycle before retrying.`,
          );
        }
      }
      throw new Error(
        "USRP B205-mini FPGA loader remained busy for 1 second; physically power-cycle before retrying.",
      );
    }
    if (![4, 5].includes(current)) {
      throw new Error(
        `USRP B205-mini FPGA loader is in unsafe initial state ${current}; close it and physically power-cycle before retrying.`,
      );
    }
    return current;
  }

  private async verifyCompatibility(
    token: number,
  ): Promise<{
    firmware: { major: 8; minor: number };
    state: UsrpB205Fx3State;
    hash: number;
  }> {
    const firmware = await this.controlIn(token, 0x15, 2);
    if (firmware[0] !== 8)
      throw new Error(
        `USRP B205-mini requires FX3 firmware major 8; detected ${firmware[0]}.${firmware[1]}. BrowserSDR will not install firmware.`,
      );
    const speed = await this.controlIn(token, 0x80, 1);
    if (speed[0] !== 3)
      throw new Error(
        `USRP B205-mini release 1 requires USB SuperSpeed value 3; detected ${speed[0]}.`,
      );
    const state = await this.initialLoaderState(token);
    return {
      firmware: { major: 8, minor: firmware[1]! },
      state,
      hash: await this.hash(token),
    };
  }

  private async load(token: number, image: Uint8Array): Promise<void> {
    await this.controlIn(token, 0x22, 512);
    await this.controlOut(token, 0x1c, Uint8Array.of(0, 0, 0, 0));
    this.diagnosticsValue = {
      ...this.diagnosticsValue,
      mutationStarted: true,
      powerCycleRequired: true,
    };
    await this.controlOut(token, 0x55, Uint8Array.of(0));
    await this.pollState(token, 1, 500, "preparation");
    await this.controlOut(token, 0x02, Uint8Array.of(0));
    await this.pollState(token, 2, 1_000, "configuration start");
    for (let offset = 0; offset < image.byteLength; offset += 512) {
      await this.controlOut(
        token,
        0x12,
        image.subarray(offset, Math.min(offset + 512, image.byteLength)),
      );
    }
    await this.pollState(token, 4, 500, "configuration");
    await this.controlOut(token, 0x1c, Uint8Array.of(0x5e, 0x15, 0x24, 0x16));
    if ((await this.hash(token)) !== USRP_B205_IMAGE.legacyHash)
      throw new Error(
        "USRP B205-mini FPGA success hash did not read back exactly; a physical USB power cycle is required.",
      );
  }

  private async postResetCheck(
    token: number,
    expectedFirmwareMinor: number,
  ): Promise<void> {
    const firmware = await this.controlIn(token, 0x15, 2);
    const speed = await this.controlIn(token, 0x80, 1);
    const state = await this.state(token);
    const hash = await this.hash(token);
    if (
      firmware[0] !== 8 ||
      firmware[1] !== expectedFirmwareMinor ||
      speed[0] !== 3 ||
      state !== 4 ||
      hash !== USRP_B205_IMAGE.legacyHash
    ) {
      throw new Error(
        "USRP B205-mini FX3 compatibility changed after GPIF reset; close and physically power-cycle before retrying.",
      );
    }
  }

  private async initialize(
    devicePromise: Promise<USBDevice>,
    imageRecord: VerifiedUsrpB205Image,
    token: number,
    firmware?: VerifiedUsrpB205Firmware,
    usb?: Pick<USB, "getDevices">,
  ): Promise<UsrpB205Fx3Identity> {
    const verified = await (this.options.verifyImage ?? defaultVerifyImage)(
      imageRecord,
    );
    this.guard(token);
    let device = await devicePromise;
    this.guard(token);
    if (device.vendorId !== 0x2500 || device.productId !== 0x0022)
      throw new Error(
        "Selected USB device is not the pinned USRP B205-mini runtime identity 2500:0022.",
      );
    if (
      !device.productName ||
      !printable(device.productName) ||
      (device.serialNumber != null && !printable(device.serialNumber))
    ) {
      throw new Error(
        "USRP B205-mini product/serial descriptors are absent or malformed.",
      );
    }
    if (!device.opened) {
      this.openPromise = device.open();
      await this.deadline(
        this.openPromise,
        this.options.ep0TimeoutMs ?? 1_000,
        "open",
      );
    }
    this.guard(token);
    if (device.configuration?.configurationValue !== 1)
      await this.deadline(
        device.selectConfiguration(1),
        this.options.ep0TimeoutMs ?? 1_000,
        "configuration selection",
      );
    this.guard(token);
    if (bootloaderDescriptor(device)) {
      if (!firmware)
        throw new Error(
          `USRP B205-mini is in WestBridge mode. Import the pinned ${USRP_B205_FIRMWARE.archiveFilename} firmware first.`,
        );
      if (!usb?.getDevices)
        throw new Error(
          "WebUSB authorized-device discovery is unavailable for FX3 re-enumeration.",
        );
      device = await this.loadRuntimeFirmware(token, device, firmware, usb);
      if (!device.opened) {
        this.openPromise = device.open();
        await this.deadline(
          this.openPromise,
          this.options.ep0TimeoutMs ?? 1_000,
          "runtime open",
        );
      }
      if (device.configuration?.configurationValue !== 1)
        await this.deadline(
          device.selectConfiguration(1),
          this.options.ep0TimeoutMs ?? 1_000,
          "runtime configuration selection",
        );
      this.guard(token);
    } else {
      this.diagnosticsValue = {
        ...this.diagnosticsValue,
        firmwareDisposition: "runtime-present",
      };
    }
    if (
      !device.productName ||
      !printable(device.productName) ||
      (device.serialNumber != null && !printable(device.serialNumber))
    ) {
      throw new Error(
        "USRP B205-mini runtime product/serial descriptors are absent or malformed.",
      );
    }
    descriptor(device);
    const compatible = await this.verifyCompatibility(token);
    let imageDisposition: UsrpB205Fx3Identity["imageDisposition"];
    if (
      compatible.state === 4 &&
      compatible.hash === USRP_B205_IMAGE.legacyHash
    ) {
      imageDisposition = "already-compatible";
    } else {
      await this.load(token, verified);
      imageDisposition = "loaded-volatile";
    }
    await this.controlOut(token, 0x72, Uint8Array.of(0, 0, 0, 0));
    await this.postResetCheck(token, compatible.firmware.minor);
    this.diagnosticsValue = {
      ...this.diagnosticsValue,
      powerCycleRequired: false,
    };
    for (const interfaceNumber of USRP_B205_CLAIM_ORDER) {
      await this.deadline(
        device.claimInterface(interfaceNumber),
        this.options.ep0TimeoutMs ?? 1_000,
        `claim interface ${interfaceNumber}`,
      );
      this.claimed.add(interfaceNumber);
      this.guard(token);
    }
    this.diagnosticsValue = {
      ...this.diagnosticsValue,
      state: "ready",
      powerCycleRequired: false,
    };
    return {
      kind: "usrp-b205-mini-fx3",
      vendorId: 0x2500,
      productId: 0x0022,
      productName: device.productName,
      serialNumber: device.serialNumber ?? null,
      descriptorLayoutVerified: true,
      firmware: compatible.firmware,
      usbSpeed: 3,
      loaderState: 4,
      fpgaLegacyHash: 0x1624155e,
      imageSha256: USRP_B205_IMAGE.memberSha256,
      imageDisposition,
      claimedInterfaces: [4, 3, 2],
      fpgaCompatibilityCheck: "pending-chdr-step-04",
    };
  }

  close(): Promise<void> {
    this.terminal = true;
    ++this.token;
    return this.cleanup();
  }

  private cleanup(): Promise<void> {
    if (this.closeTask) return this.closeTask;
    if (this.diagnosticsValue.state === "closed") return Promise.resolve();
    this.diagnosticsValue = { ...this.diagnosticsValue, state: "closing" };
    const task = (async () => {
      await this.permission?.catch(() => undefined);
      await this.openPromise?.catch(() => undefined);
      const device = this.device;
      const errors: string[] = [];
      if (device?.opened && this.diagnosticsValue.state !== "opening") {
        for (const interfaceNumber of USRP_B205_RELEASE_ORDER) {
          if (!this.claimed.has(interfaceNumber)) continue;
          try {
            if (!device.releaseInterface)
              throw new Error("WebUSB releaseInterface is unavailable.");
            await device.releaseInterface(interfaceNumber);
            this.claimed.delete(interfaceNumber);
          } catch (error) {
            errors.push(error instanceof Error ? error.message : String(error));
          }
        }
      }
      try {
        if (device?.opened) await device.close();
      } catch (error) {
        errors.push(error instanceof Error ? error.message : String(error));
        this.diagnosticsValue = {
          ...this.diagnosticsValue,
          state: "cleanup-required",
          cleanupErrors: errors,
        };
        throw error;
      }
      this.claimed.clear();
      this.diagnosticsValue = {
        ...this.diagnosticsValue,
        state: "closed",
        cleanupErrors: errors,
      };
    })().finally(() => {
      if (this.closeTask === task) this.closeTask = undefined;
    });
    this.closeTask = task;
    return task;
  }
}

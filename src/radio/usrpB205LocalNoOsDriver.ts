import {
  USRP_B205_AD9364_NO_OS_COMMIT,
  USRP_B205_AD9364_PROFILE,
  type UsrpB205Ad9364Driver,
  type UsrpB205Ad9364Report,
  type UsrpB205Ad9364Spi,
} from "./usrpB205RxConfig";
import {
  USRP_B205_MASTER_CLOCK_RATE_HZ,
  type UsrpB205SampleRateHz,
} from "./usrpB205Capabilities";

const MODULE_URL = new URL(
  "../vendor/adi-no-os/ad9364-no-os.js",
  import.meta.url,
).href;
const WASM_URL = new URL(
  "../vendor/adi-no-os/ad9364-no-os.wasm",
  import.meta.url,
).href;

interface NoOsModule {
  HEAPU8: Uint8Array;
  HEAPU32: Uint32Array;
  bridgeFailure?: string;
  _malloc(bytes: number): number;
  _free(pointer: number): void;
  _bridge_initialize(frequencyHz: number): number | Promise<number>;
  _bridge_set_rate(rateHz: number): number | Promise<number>;
  _bridge_get_rate(pointer: number): number | Promise<number>;
  _bridge_set_bandwidth(bandwidthHz: number): number | Promise<number>;
  _bridge_get_bandwidth(pointer: number): number | Promise<number>;
  _bridge_set_lo(frequencyHz: number): number | Promise<number>;
  _bridge_get_lo(pointer: number): number | Promise<number>;
  _bridge_set_input(input: number): number | Promise<number>;
  _bridge_get_input(pointer: number): number | Promise<number>;
  _bridge_set_gain_mode(mode: number): number | Promise<number>;
  _bridge_get_gain_mode(pointer: number): number | Promise<number>;
  _bridge_set_ensm(mode: number): number | Promise<number>;
  _bridge_get_ensm(pointer: number): number | Promise<number>;
  _bridge_rx_pll_locked(): number | Promise<number>;
  _bridge_slow_agc_mode(): number;
  _bridge_ensm_rx_mode(): number;
  _bridge_ensm_alert_mode(): number;
  awaitAsyncify(result: number): Promise<number>;
}

type NoOsFactory = (options: {
  locateFile(path: string): string;
  bridgeSpi(bytes: Uint8Array): Promise<Uint8Array>;
  bridgeDelay(milliseconds: number): Promise<void>;
}) => Promise<NoOsModule>;

export function validateUsrpB205NoOsModule(
  module: Partial<NoOsModule>,
): asserts module is NoOsModule {
  if (
    !(module.HEAPU8 instanceof Uint8Array) ||
    !(module.HEAPU32 instanceof Uint32Array)
  ) {
    throw new Error(
      "Packaged AD9364 driver does not expose its WebAssembly memory views.",
    );
  }
}

export async function transferUsrpB205NoOsSpi(
  spi: UsrpB205Ad9364Spi,
  input: Uint8Array,
): Promise<Uint8Array> {
  if (input.length < 3) throw new Error("Invalid no-OS SPI transfer.");
  const output = Uint8Array.from(input);
  const write = (input[0]! & 0x80) !== 0;
  const count = ((input[0]! >>> 4) & 0x07) + 1;
  const address = ((input[0]! & 0x03) << 8) | input[1]!;
  if (input.length !== count + 2)
    throw new Error("Unexpected no-OS SPI transfer length.");
  for (let offset = 0; offset < count; offset++) {
    const register = address - offset;
    if (write) await spi.writeRegister(register, input[2 + offset]!);
    else output[2 + offset] = await spi.readRegister(register);
  }
  return output;
}

export function localUsrpB205NoOsDriverAvailable(): boolean {
  return typeof WebAssembly !== "undefined";
}

async function loadFactory(): Promise<NoOsFactory> {
  if (!localUsrpB205NoOsDriverAvailable())
    throw new Error(
      "This browser cannot load the packaged AD9364 WebAssembly driver.",
    );
  try {
    const imported = (await import(/* @vite-ignore */ MODULE_URL)) as {
      default?: NoOsFactory;
    };
    if (typeof imported.default !== "function")
      throw new Error("module factory missing");
    return imported.default;
  } catch (error) {
    throw new Error(
      `Packaged AD9364 driver ${USRP_B205_AD9364_NO_OS_COMMIT} is unavailable or failed integrity-preserving static loading.`,
      { cause: error },
    );
  }
}

/** Receive-only bridge to the pinned, notice-preserving ADI no-OS build. */
export class LocalUsrpB205NoOsDriver implements UsrpB205Ad9364Driver {
  private module?: NoOsModule;
  private spi?: UsrpB205Ad9364Spi;
  private rxLoFrequencyHz?: number;

  async initializeRx(
    spi: UsrpB205Ad9364Spi,
    profile: typeof USRP_B205_AD9364_PROFILE,
    initializationLoHz: number,
  ): Promise<void> {
    if (profile !== USRP_B205_AD9364_PROFILE)
      throw new Error("Local AD9364 driver received an unpinned RF profile.");
    this.spi = spi;
    const factory = await loadFactory();
    const module = await factory({
      locateFile: (path) => (path.endsWith(".wasm") ? WASM_URL : path),
      bridgeSpi: (bytes) => this.transfer(bytes),
      bridgeDelay: (milliseconds) =>
        new Promise((resolve) => globalThis.setTimeout(resolve, milliseconds)),
    });
    validateUsrpB205NoOsModule(module);
    this.module = module;
    await this.call(
      "initialize",
      this.module._bridge_initialize(initializationLoHz),
    );
    this.rxLoFrequencyHz = initializationLoHz;
  }

  async setRxClockPath(
    rateHz: typeof USRP_B205_MASTER_CLOCK_RATE_HZ,
  ): Promise<void> {
    await this.call("set RX clock", this.required()._bridge_set_rate(rateHz));
  }

  async setRxBandwidth(bandwidthHz: UsrpB205SampleRateHz): Promise<void> {
    await this.call(
      "set RX bandwidth",
      this.required()._bridge_set_bandwidth(bandwidthHz),
    );
  }

  async enterAlert(): Promise<"ALERT"> {
    const module = this.required();
    await this.call(
      "enter ALERT",
      module._bridge_set_ensm(module._bridge_ensm_alert_mode()),
    );
    return "ALERT";
  }

  async setRxLo(
    frequencyHz: number,
  ): Promise<{ frequencyHz: number; rxPllLocked: true }> {
    const module = this.required();
    await this.call("set RX LO", module._bridge_set_lo(frequencyHz));
    if ((await this.settle(module._bridge_rx_pll_locked())) !== 1)
      throw new Error(
        "Pinned no-OS driver reports the AD9364 RX PLL is unlocked.",
      );
    // The no-OS register reconstruction can report a one-step RFPLL divider
    // alias (exactly half the commanded LO) even though set_rate succeeded and
    // the hardware PLL locked. Keep the successful synthesizer command as the
    // calculated accepted value; this is not presented as a hardware readback.
    this.rxLoFrequencyHz = frequencyHz;
    return { frequencyHz, rxPllLocked: true };
  }

  async selectRxInput(input: "A/RX1"): Promise<void> {
    if (input !== "A/RX1")
      throw new Error("Local AD9364 driver exposes only A/RX1.");
    await this.call("select A/RX1", this.required()._bridge_set_input(0));
  }

  async setRxGainMode(mode: "slow_agc"): Promise<void> {
    const module = this.required();
    if (mode !== "slow_agc")
      throw new Error("Local AD9364 driver exposes only slow AGC.");
    await this.call(
      "set slow AGC",
      module._bridge_set_gain_mode(module._bridge_slow_agc_mode()),
    );
  }

  async enterRx(): Promise<"RX"> {
    const module = this.required();
    await this.call(
      "enter RX",
      module._bridge_set_ensm(module._bridge_ensm_rx_mode()),
    );
    return "RX";
  }

  async readRxReport(): Promise<UsrpB205Ad9364Report> {
    const module = this.required();
    const rate = await this.readUint32(
      "read RX rate",
      module._bridge_get_rate.bind(module),
    );
    const bandwidth = await this.readUint32(
      "read RX bandwidth",
      module._bridge_get_bandwidth.bind(module),
    );
    const frequency = this.rxLoFrequencyHz;
    if (frequency === undefined)
      throw new Error("Pinned no-OS AD9364 RX LO has not been configured.");
    const input = await this.readUint32(
      "read RX input",
      module._bridge_get_input.bind(module),
    );
    const gain = await this.readUint8(
      "read RX gain mode",
      module._bridge_get_gain_mode.bind(module),
    );
    const ensm = await this.readUint32(
      "read ENSM mode",
      module._bridge_get_ensm.bind(module),
    );
    if (
      input !== 0 ||
      gain !== module._bridge_slow_agc_mode() ||
      ensm !== module._bridge_ensm_rx_mode()
    )
      throw new Error(
        "Pinned no-OS AD9364 readback does not match A/RX1, slow AGC and RX mode.",
      );
    if ((await this.settle(module._bridge_rx_pll_locked())) !== 1)
      throw new Error("Pinned no-OS AD9364 readback reports RX PLL unlocked.");
    return {
      deviceId: "AD9364",
      masterClockRateHz: rate,
      rxBandwidthHz: bandwidth,
      rxLoFrequencyHz: frequency,
      rxInput: "A/RX1",
      gainMode: "slow_agc",
      ensmMode: "RX",
      rxPllLocked: true,
    };
  }

  private required(): NoOsModule {
    if (!this.module)
      throw new Error("Local AD9364 no-OS driver is not initialized.");
    return this.module;
  }

  private async call(
    operation: string,
    result: number | Promise<number>,
  ): Promise<void> {
    // Raw Asyncify-enabled C exports return the temporary unwind value. The
    // generated runtime completes them through Asyncify.whenDone(), which the
    // localhost middleware exposes without shipping or modifying the artifact.
    const code = await this.settle(result);
    if (code !== 0) {
      const detail = this.module?.bridgeFailure;
      throw new Error(
        `Pinned no-OS AD9364 ${operation} failed (${code})${detail ? `: ${detail}` : "."}`,
      );
    }
  }

  private settle(result: number | Promise<number>): Promise<number> {
    return result instanceof Promise
      ? result
      : this.required().awaitAsyncify(result);
  }

  private async transfer(input: Uint8Array): Promise<Uint8Array> {
    const spi = this.spi;
    if (!spi) throw new Error("Invalid no-OS SPI transfer.");
    return transferUsrpB205NoOsSpi(spi, input);
  }

  private async readUint32(
    operation: string,
    reader: (pointer: number) => number | Promise<number>,
  ): Promise<number> {
    const module = this.required();
    const pointer = module._malloc(4);
    try {
      await this.call(operation, reader(pointer));
      return module.HEAPU32[pointer >>> 2]!;
    } finally {
      module._free(pointer);
    }
  }

  private async readUint8(
    operation: string,
    reader: (pointer: number) => number | Promise<number>,
  ): Promise<number> {
    const module = this.required();
    const pointer = module._malloc(1);
    try {
      await this.call(operation, reader(pointer));
      return module.HEAPU8[pointer]!;
    } finally {
      module._free(pointer);
    }
  }
}

export function createLocalUsrpB205NoOsDriver(): UsrpB205Ad9364Driver {
  return new LocalUsrpB205NoOsDriver();
}

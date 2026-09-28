import {
  USRP_B205_BANDWIDTH_HZ,
  USRP_B205_EFFECTIVE_SAMPLE_RATE_HZ,
  USRP_B205_FPGA_DECIMATION,
  USRP_B205_FPGA_SHA256,
  USRP_B205_MASTER_CLOCK_RATE_HZ,
  USRP_B205_SAMPLE_RATE_HZ,
  usrpB205RateProfile,
  type UsrpB205SampleRateHz,
  createUsrpB205RequestedConfiguration,
  discoverUsrpB205Capabilities,
  validateUsrpB205SessionDetails,
  type UsrpB205AcceptedConfiguration,
  type UsrpB205RequestedConfiguration,
  type UsrpB205SessionDetails,
} from "./usrpB205Capabilities";
import { UsrpB205ControlLink } from "./usrpB205Control";
import type { UsrpB205Fx3Identity } from "./usrpB205Fx3";

const LOCAL = 0x40 as const;
const RADIO = 0x10 as const;
const address = (setting: number) => setting * 4;

export const USRP_B205_AD9364_NO_OS_COMMIT =
  "42d9893169f57b10c3d249a98633051e9ff037be" as const;

/** Complete policy delta applied to the pinned no-OS baseline; no TX operation is exposed by the adapter. */
export const USRP_B205_AD9364_PROFILE = Object.freeze({
  baseline: "ad9361_init_param_default",
  noOsCommit: USRP_B205_AD9364_NO_OS_COMMIT,
  device: "ID_AD9364",
  referenceClockHz: 40_000_000,
  rxSampleClockHz: USRP_B205_MASTER_CLOCK_RATE_HZ,
  hostSampleRateHz: USRP_B205_SAMPLE_RATE_HZ,
  fpgaRxDecimation: USRP_B205_FPGA_DECIMATION,
  rxChannels: 1,
  txChannelsRequiredByGenericInitializer: 1,
  twoRxTwoTx: false,
  fdd: false,
  fddIndependent: false,
  tddDualSynth: false,
  externalRxLo: false,
  externalTxLo: false,
  ensmPulseMode: false,
  txnrxPinControl: false,
  unusedTxLoHz: 2_400_000_000,
  txLoPowerdownManaged: true,
  txAttenuationMdB: 89_750,
  updateTxGainInAlert: false,
  rxBandwidthHz: USRP_B205_BANDWIDTH_HZ,
  rxInput: "A/RX1",
  externalReferenceInput: true,
  clockOutput: "disabled",
  interface: "CMOS-DDR-single-port-half-duplex-RX",
  parallelPortSwap: false,
  singlePort: true,
  halfDuplex: true,
  fullPort: false,
  framePulse: true,
  twoTTwoRTiming: false,
  delays: Object.freeze({
    rxClock: 0,
    rxData: 15,
    txFeedbackClock: 0,
    txData: 15,
  }),
  auxDacActiveInTx: false,
  gpoSlaveTx: false,
  txMonitorTracking: false,
  externalLna: false,
  digitalInterfaceTuneSkipMode: 2,
  txFir: "never-load",
  terminalEnsmMode: "RX",
} as const);

export interface UsrpB205Ad9364Spi {
  readRegister(register: number): Promise<number>;
  writeRegister(register: number, value: number): Promise<void>;
}

export interface UsrpB205Ad9364Report {
  readonly deviceId: "AD9364";
  readonly masterClockRateHz: number;
  readonly rxBandwidthHz: number;
  readonly rxLoFrequencyHz: number;
  readonly rxInput: "A/RX1";
  readonly gainMode: "slow_agc";
  readonly ensmMode: "RX";
  readonly rxPllLocked: true;
}

/** Narrow binding implemented from the pinned per-file BSD no-OS closure. */
export interface UsrpB205Ad9364Driver {
  initializeRx(
    spi: UsrpB205Ad9364Spi,
    profile: typeof USRP_B205_AD9364_PROFILE,
    initializationLoHz: number,
  ): Promise<void>;
  setRxClockPath(rateHz: typeof USRP_B205_MASTER_CLOCK_RATE_HZ): Promise<void>;
  setRxBandwidth(bandwidthHz: UsrpB205SampleRateHz): Promise<void>;
  enterAlert(): Promise<"ALERT">;
  setRxLo(
    frequencyHz: number,
  ): Promise<{ frequencyHz: number; rxPllLocked: true }>;
  selectRxInput(input: "A/RX1"): Promise<void>;
  setRxGainMode(mode: "slow_agc"): Promise<void>;
  enterRx(): Promise<"RX">;
  readRxReport(): Promise<UsrpB205Ad9364Report>;
}

function stagingRxLoHz(requestedHz: number): number {
  // Keep initialization inside the AD9364/B205 tuning range while ensuring
  // that the final saved-channel request cannot be elided by the no-OS RFPLL
  // request cache after the sample clock path has been changed.
  return requestedHz <= 5_999_000_000
    ? requestedHz + 1_000_000
    : requestedHz - 1_000_000;
}

export interface UsrpB205RxBoundary {
  stopAndDrain(): Promise<void>;
  incrementGenerationAndDiscardOldPackets(): void;
  acceptSession(details: UsrpB205SessionDetails): void;
  resetExpectedRxSequence(): void;
  restart(): Promise<void>;
}

export interface UsrpB205RxConfiguratorOptions {
  closeOwner(): Promise<void>;
  pause?(milliseconds: number): Promise<void>;
  rfInitializationTimeoutMs?: number;
}

export class UsrpB205Ad9364SpiAdapter implements UsrpB205Ad9364Spi {
  constructor(private readonly control: UsrpB205ControlLink) {}

  async configure(): Promise<void> {
    await this.control.poke32(LOCAL, address(8), 49);
    await this.control.poke32(LOCAL, address(9), 0x98000001);
  }

  async readRegister(register: number): Promise<number> {
    this.validateRegister(register);
    const command = ((register & 0x3fff) << 8) >>> 0;
    await this.control.poke32(LOCAL, address(10), (command << 8) >>> 0);
    return (await this.control.peek32(LOCAL, 8)) & 0xff;
  }

  async writeRegister(register: number, value: number): Promise<void> {
    this.validateRegister(register);
    if (!Number.isInteger(value) || value < 0 || value > 0xff)
      throw new Error("AD9364 SPI write value must be one byte.");
    const command = (0x00800000 | ((register & 0x3fff) << 8) | value) >>> 0;
    await this.control.poke32(LOCAL, address(10), (command << 8) >>> 0);
  }

  private validateRegister(register: number): void {
    if (!Number.isInteger(register) || register < 0 || register > 0x3fff)
      throw new Error("AD9364 SPI register must be a 14-bit integer.");
  }
}

function deadline<T>(promise: Promise<T>, milliseconds: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () =>
        reject(
          new DOMException(
            "USRP B205-mini AD9364 initialization exceeded its wall-clock bound.",
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

function sameRequest(
  left: UsrpB205RequestedConfiguration,
  right: UsrpB205RequestedConfiguration,
): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

export interface UsrpB205ConfigurationDiagnostics {
  readonly stage: string;
  readonly rfStateUnknown: boolean;
  readonly powerCycleRequired: boolean;
}

/** Ordered FPGA/RFIC configuration transaction. It never starts endpoint-6 sample reads. */
export class UsrpB205RxConfigurator {
  private configured: UsrpB205SessionDetails | null = null;
  private stage = "idle";
  private rfTouched = false;
  private atrWritesStarted = false;
  private terminal = false;
  private resumeRfBeforeStart = false;

  constructor(
    private readonly identity: UsrpB205Fx3Identity,
    private readonly control: UsrpB205ControlLink,
    private readonly driver: UsrpB205Ad9364Driver,
    private readonly options: UsrpB205RxConfiguratorOptions,
  ) {}

  get diagnostics(): UsrpB205ConfigurationDiagnostics {
    return {
      stage: this.stage,
      rfStateUnknown: this.rfTouched && !this.configured,
      powerCycleRequired: this.rfTouched && !this.configured,
    };
  }

  async initialize(
    requested: UsrpB205RequestedConfiguration,
  ): Promise<UsrpB205SessionDetails> {
    const canonical = createUsrpB205RequestedConfiguration(
      requested.requestedCenterFrequencyHz,
      requested.requestedSampleRateHz,
    );
    if (!sameRequest(canonical, requested))
      throw new Error(
        "USRP B205-mini requested configuration is outside the frozen release-1 profile.",
      );
    if (this.terminal)
      throw new DOMException(
        "USRP B205-mini configuration owner is closed.",
        "InvalidStateError",
      );
    if (this.configured) {
      if (!sameRequest(this.configured.configuration.requested, requested)) {
        throw new Error(
          "A configured USRP B205-mini accepts only a center-frequency retune; other changes require full close.",
        );
      }
      return structuredClone(this.configured);
    }
    this.control.start();
    try {
      this.stage = "fpga-compatibility";
      const compatibility = await this.control.peek64(LOCAL, 0);
      const signature = Number((compatibility >> 32n) & 0xffff_ffffn);
      const version = Number(compatibility & 0xffff_ffffn);
      const compatibilityMajor = version >>> 16;
      const compatibilityMinor = version & 0xffff;
      if (signature !== 0xace0ba5e || compatibilityMajor !== 7)
        throw new Error(
          "USRP B205-mini FPGA signature/compatibility is not ACE0BA5E/7.x.",
        );
      const capabilities = discoverUsrpB205Capabilities({
        identity: {
          kind: "usrp-b205-mini",
          vendorId: 0x2500,
          productId: 0x0022,
          productName: this.identity.productName,
          serialNumber: this.identity.serialNumber,
        },
        descriptorLayoutVerified: this.identity.descriptorLayoutVerified,
        firmware: this.identity.firmware,
        usbSpeed: this.identity.usbSpeed,
        fpga: {
          signature: 0xace0ba5e,
          compatibilityMajor: 7,
          compatibilityMinor,
          imageSha256: USRP_B205_FPGA_SHA256,
          legacyHash: this.identity.fpgaLegacyHash,
        },
      });

      this.stage = "core-status";
      const coreStatus = await this.control.peek32(LOCAL, 20);
      if (((coreStatus >>> 8) & 0xff) !== 1)
        throw new Error(
          "USRP B205-mini FPGA core did not report exactly one radio chain.",
        );

      this.stage = "codec-reset";
      await this.control.poke32(LOCAL, address(16), 4);
      await (this.options.pause?.(1) ??
        new Promise<void>((resolve) => setTimeout(resolve, 1)));
      await this.control.poke32(LOCAL, address(16), 0);

      this.stage = "ad9364-initialize";
      const spi = new UsrpB205Ad9364SpiAdapter(this.control);
      await spi.configure();
      this.rfTouched = true;
      const configureRf = async () => {
        await this.driver.initializeRx(
          spi,
          USRP_B205_AD9364_PROFILE,
          stagingRxLoHz(requested.requestedCenterFrequencyHz),
        );

        // The radio-control cores are clocked from the AD9364 interface. UHD does
        // not construct or probe SID 0x10 until init_codec() has turned those
        // clocks on. Keep all pre-clock traffic on the local-control SID.
        this.stage = "safe-atr";
        this.atrWritesStarted = true;
        for (const setting of [12, 13, 14, 15])
          await this.control.poke32(RADIO, address(setting), 0x48);
        await this.control.poke32(RADIO, address(16), 0);
        await this.control.poke32(RADIO, address(17), 0);

        await this.driver.setRxClockPath(USRP_B205_MASTER_CLOCK_RATE_HZ);
        await this.driver.setRxBandwidth(requested.requestedBandwidthHz);
        // ad9361_init() already leaves the ENSM in RX.  The clock and bandwidth
        // changes above can therefore be followed by an LO request which the
        // no-OS clock cache regards as unchanged from initialization.  Moving
        // through ALERT makes the initial tune use the same, known-good state
        // transition as a user-initiated retune and latches the synthesizer
        // configuration before streaming starts.
        if ((await this.driver.enterAlert()) !== "ALERT")
          throw new Error(
            "USRP B205-mini AD9364 failed to enter ALERT for initial tune.",
          );
        await this.driver.setRxLo(requested.requestedCenterFrequencyHz);
        await this.driver.selectRxInput("A/RX1");
        await this.driver.setRxGainMode("slow_agc");
        if ((await this.driver.enterRx()) !== "RX")
          throw new Error("USRP B205-mini AD9364 failed to finish in RX mode.");
        return this.driver.readRxReport();
      };
      const report = await deadline(
        configureRf(),
        this.options.rfInitializationTimeoutMs ?? 30_000,
      );
      this.validateDriverReport(report);

      this.stage = "rx-registers";
      await this.control.poke32(LOCAL, address(48), 2);
      await this.control.poke32(RADIO, address(13), 0x4c);
      const rate = usrpB205RateProfile(requested.requestedSampleRateHz);
      for (const [setting, value] of [
        [136, 0],
        [147, 0],
        [144, 0],
        [145, 0x9b57],
        [146, rate.dspDecimationRegister],
        [100, 4086],
        [101, 0xa0],
      ] as const) {
        await this.control.poke32(RADIO, address(setting), value);
      }
      await this.control.poke32(RADIO, address(128), 0);
      await this.control.poke32(RADIO, address(129), 0);
      await this.control.poke32(RADIO, address(130), 4);
      await this.control.poke32(LOCAL, address(48), 2);
      await this.control.poke32(LOCAL, address(48), 6);
      await this.control.poke32(LOCAL, address(48), 2);

      this.stage = "pll-status";
      const pllStatus = await this.control.peek32(LOCAL, 24);
      if ((pllStatus & 0x2) === 0)
        throw new Error("USRP B205-mini FPGA did not observe RX PLL lock.");

      const accepted: UsrpB205AcceptedConfiguration = {
        requested: structuredClone(requested),
        acceptedCenterFrequencyHz: report.rxLoFrequencyHz,
        centerFrequencyEvidence: "rf-synthesizer-calculated",
        acceptedSampleRateHz: rate.sampleRateHz,
        sampleRateEvidence: "ddc-calculated",
        acceptedBandwidthHz: report.rxBandwidthHz,
        bandwidthEvidence: "ad9361-readback",
        acceptedMasterClockRateHz: USRP_B205_MASTER_CLOCK_RATE_HZ,
        masterClockEvidence: "rf-driver-calculated",
        acceptedAntenna: "RX2",
        acceptedClockSource: "internal",
        acceptedTimeSource: "internal",
        acceptedGainMode: "slow_agc",
        acceptedGainDb: null,
      };
      const details: UsrpB205SessionDetails = {
        capabilities,
        nativeEncoding: "chdr-vrt-sc16-le",
        nativeSampleRateHz: rate.sampleRateHz,
        effectiveSampleRateHz: USRP_B205_EFFECTIVE_SAMPLE_RATE_HZ,
        configuration: accepted,
        observations: {
          ad9364DeviceIdVerified: true,
          rxPllLocked: true,
          timestampRateValidation: "pending",
        },
        hardwareValidation: "pending",
      };
      validateUsrpB205SessionDetails(details);
      this.configured = details;
      this.stage = "configured-stopped";
      return structuredClone(details);
    } catch (error) {
      this.stage = this.rfTouched ? "failed-power-cycle-required" : "failed";
      if (this.atrWritesStarted) await this.bestEffortSafeAtr();
      this.terminal = true;
      await this.control.close(error);
      try {
        await this.options.closeOwner();
      } catch {
        /* Owner retains retryable cleanup state. */
      }
      throw error;
    }
  }

  async startContinuous(): Promise<void> {
    this.requireConfigured();
    if (this.resumeRfBeforeStart) {
      if ((await this.driver.enterRx()) !== "RX")
        throw new Error(
          "USRP B205-mini AD9364 failed to enter RX before restart.",
        );
      await this.control.poke32(RADIO, address(13), 0x4c);
      this.resumeRfBeforeStart = false;
    }
    await this.streamCommand(0xe0000001);
    this.stage = "stream-command-started";
  }

  async stopContinuous(): Promise<void> {
    this.requireConfigured();
    await this.control.safetyPokes([
      { sid: RADIO, byteAddress: address(96), value: 0x90000000 },
      { sid: RADIO, byteAddress: address(97), value: 0 },
      { sid: RADIO, byteAddress: address(98), value: 0 },
      { sid: RADIO, byteAddress: address(12), value: 0x48 },
      { sid: RADIO, byteAddress: address(13), value: 0x48 },
      { sid: RADIO, byteAddress: address(14), value: 0x48 },
      { sid: RADIO, byteAddress: address(15), value: 0x48 },
    ]);
    if ((await this.driver.enterAlert()) !== "ALERT")
      throw new Error(
        "USRP B205-mini AD9364 failed to enter ALERT after stop.",
      );
    this.resumeRfBeforeStart = true;
    this.stage = "configured-stopped";
  }

  async retune(
    centerFrequencyHz: number,
    boundary: UsrpB205RxBoundary,
  ): Promise<UsrpB205SessionDetails> {
    const previous = this.requireConfigured();
    const requested = createUsrpB205RequestedConfiguration(
      centerFrequencyHz,
      previous.nativeSampleRateHz,
    );
    try {
      await boundary.stopAndDrain();
      boundary.incrementGenerationAndDiscardOldPackets();
      if ((await this.driver.enterAlert()) !== "ALERT")
        throw new Error(
          "USRP B205-mini AD9364 failed to enter ALERT for retune.",
        );
      const result = await this.driver.setRxLo(centerFrequencyHz);
      if (!result.rxPllLocked)
        throw new Error(
          "USRP B205-mini AD9364 RX PLL did not lock after retune.",
        );
      if ((await this.driver.enterRx()) !== "RX")
        throw new Error(
          "USRP B205-mini AD9364 failed to return to RX after retune.",
        );
      const accepted = {
        ...previous.configuration,
        requested,
        acceptedCenterFrequencyHz: result.frequencyHz,
      };
      const next = { ...previous, configuration: accepted };
      validateUsrpB205SessionDetails(next);
      this.configured = next;
      boundary.acceptSession(next);
      boundary.resetExpectedRxSequence();
      await boundary.restart();
      this.stage = "stream-command-started";
      return structuredClone(next);
    } catch (error) {
      this.configured = null;
      this.stage = "failed-power-cycle-required";
      this.terminal = true;
      await this.bestEffortSafeAtr();
      await this.control.close(error);
      try {
        await this.options.closeOwner();
      } catch {
        /* Owner retains retryable cleanup state. */
      }
      throw error;
    }
  }

  private validateDriverReport(report: UsrpB205Ad9364Report): void {
    if (
      report.deviceId !== "AD9364" ||
      Math.abs(report.masterClockRateHz - USRP_B205_MASTER_CLOCK_RATE_HZ) > 1 ||
      !Number.isSafeInteger(report.rxBandwidthHz) ||
      report.rxBandwidthHz <= 0 ||
      !Number.isSafeInteger(report.rxLoFrequencyHz) ||
      report.rxLoFrequencyHz < 70_000_000 ||
      report.rxLoFrequencyHz > 6_000_000_000 ||
      report.rxInput !== "A/RX1" ||
      report.gainMode !== "slow_agc" ||
      report.ensmMode !== "RX" ||
      report.rxPllLocked !== true
    ) {
      throw new Error(
        "USRP B205-mini AD9364 report does not prove the frozen RX-only profile.",
      );
    }
  }

  private requireConfigured(): UsrpB205SessionDetails {
    if (!this.configured || this.terminal)
      throw new DOMException(
        "USRP B205-mini is not safely configured.",
        "InvalidStateError",
      );
    return this.configured;
  }

  private async streamCommand(command: number): Promise<void> {
    await this.control.poke32(RADIO, address(96), command);
    await this.control.poke32(RADIO, address(97), 0);
    await this.control.poke32(RADIO, address(98), 0);
  }

  private async bestEffortSafeAtr(): Promise<void> {
    try {
      await this.control.safetyPokes(
        [12, 13, 14, 15].map((setting) => ({
          sid: RADIO,
          byteAddress: address(setting),
          value: 0x48,
        })),
      );
    } catch {
      /* Closing is safer than guessing recovery after a failed safe-state write. */
    }
  }
}

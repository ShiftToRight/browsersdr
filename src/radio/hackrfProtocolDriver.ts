import { isWidebandRate, isStableHackrfApi, validateHackrfIdentity, discoverHackrfCapabilities, validateHackrfSessionDetails, hackrfDecimationExponent, hackrfDecimationFactor, channelSampleRate, hostResamplingForRate, type HackrfIdentity, type HackrfSessionDetails } from "./sourceCapabilities";
import { HACKRF_DEADLINE_MS, validateHackrfConfiguration, hackrfRegisterPayload, hackrfRatePayload, hackrfFrequencyPayload, decodeHackrfFixed, verifyHackrfDescriptor, type HackrfControlIo, type HackrfConfiguration, type HackrfConfiguredSession } from "./hackrfProtocol";
const UNSET = 0xffff_ffff_ffff_ffffn;

/** All control operations are awaited in order; the transport enforces deadlines. */
export class HackrfProtocol {
  private pollDeadline?: number;
  constructor(private readonly io: HackrfControlIo) {}
  private read(register: number): Promise<bigint> {
    return this.io.input(60, register, 0, 8, 8, this.pollDeadline === undefined ? undefined : this.pollDeadline - this.io.now()).then((view) => view.getBigUint64(0, true));
  }
  private write(bank: 1 | 2 | 3, register: number, value: bigint): Promise<void> {
    return this.io.output(59, 0, bank, hackrfRegisterPayload(register, value));
  }
  private async poll<T>(read: () => Promise<T | undefined>): Promise<T> {
    const deadline = this.io.now() + HACKRF_DEADLINE_MS;
    this.pollDeadline = deadline;
    try {
      for (let round = 0; round < 20 && this.io.now() < deadline; round++) {
        const result = await read();
        if (this.io.now() > deadline) break;
        if (result !== undefined) return result;
        if (round < 19) await this.io.pause(10);
      }
      throw new Error("HackRF reported settings did not settle within the profile deadline.");
    } finally { this.pollDeadline = undefined; }
  }

  async identify(device: USBDevice): Promise<HackrfIdentity> {
    verifyHackrfDescriptor(device);
    const boardId = (await this.io.input(14, 0, 0, 1)).getUint8(0);
    const firmware = await this.io.input(15, 0, 0, 32, 1);
    if (firmware.byteLength > 31) throw new Error("Invalid HackRF firmware string length.");
    const firmwareVersion = String.fromCharCode(...new Uint8Array(firmware.buffer, firmware.byteOffset, firmware.byteLength));
    const usbApiVersion = device.deviceVersionMajor * 256 + device.deviceVersionMinor * 16 + device.deviceVersionSubminor;
    if ((boardId === 2 || boardId === 4) && usbApiVersion !== 0x0110) throw new Error(`HackRF One experimental support requires USB API 0x0110 (official v2026.01.3 baseline); detected API 0x${usbApiVersion.toString(16)}. No device setup was sent.`);
    const part = await this.io.input(18, 0, 0, 24);
    const boardRevisionRaw = (await this.io.input(45, 0, 0, 1)).getUint8(0);
    const platformSupport = (await this.io.input(46, 0, 0, 4)).getUint32(0, false);
    const identity: HackrfIdentity = { kind: boardId === 2 || boardId === 4 ? "hackrf-one" : "hackrf-pro", vendorId: device.vendorId, productId: device.productId,
      boardId, firmwareVersion, boardRevisionRaw, platformSupport, usbApiVersion,
      partIdWords: [part.getUint32(0, true), part.getUint32(4, true)],
      serialWords: [part.getUint32(8, true), part.getUint32(12, true), part.getUint32(16, true), part.getUint32(20, true)] };
    validateHackrfIdentity(identity);
    return identity;
  }
  async configure(identity: HackrfIdentity, config: HackrfConfiguration): Promise<HackrfConfiguredSession> {
    validateHackrfConfiguration(config, identity);
    if (identity.kind === "hackrf-one") return this.configureOne(identity, config);
    if (isStableHackrfApi(identity.usbApiVersion)) return this.configureStable(identity, config);
    await this.io.output(1, 0, 0);
    await this.poll(async () => await this.read(0) === 0n ? true : undefined);
    for (const bank of [2, 3] as const) {
      for (let register = 1; register < 24; register++) await this.write(bank, register, UNSET);
      await this.write(bank, 20, 0n);
    }
    await this.io.output(54, 0, 0);
    for (let register = 1; register <= 6; register++) await this.io.output(49, register === 1 ? 1 : 0, register);
    await this.write(1, 5, UNSET);
    await this.write(1, 8, BigInt(hackrfDecimationExponent(config.sampleRateHz)));
    await this.write(1, 23, 2n ** 63n);
    await this.write(1, 22, 1n);
    await this.io.output(6, 0, 0, hackrfRatePayload(config.sampleRateHz));
    await this.io.output(16, 0, 0, hackrfFrequencyPayload(config.centerFrequencyHz));
    for (const [request, value] of [[19, config.settings.rxLnaGainCode], [20, config.settings.rxVgaGainDb]] as const) {
      if ((await this.io.input(request, 0, value, 1)).getUint8(0) !== 1) throw new Error("HackRF RX gain setter rejected its value.");
    }
    await this.io.output(17, config.settings.rfAmplifierEnabled ? 1 : 0, 0);
    await this.io.output(23, 0, 0); await this.io.output(29, 0, 0);
    const session = await this.reported(identity, config, false);
    await this.verifyFpga(session, true);
    return session;
  }
  async verifyRx(identity: HackrfIdentity, config: HackrfConfiguration): Promise<HackrfConfiguredSession> {
    if (identity.kind === "hackrf-one") return this.verifyOneRx(identity, config);
    if (isStableHackrfApi(identity.usbApiVersion)) return this.verifyStableRx(identity, config);
    const session = await this.reported(identity, config, true);
    await this.verifyFpga(session, false);
    return session;
  }
  private async setOneRateAndFilter(config: HackrfConfiguration): Promise<void> {
    await this.io.output(6, 0, 0, hackrfRatePayload(config.sampleRateHz));
    // libhackrf: widest hardware filter <= 75% of native rate, 7 MHz at 9.6 MS/s.
    await this.io.output(7, 7_000_000 & 0xffff, 7_000_000 >>> 16);
  }
  private async configureOne(identity: HackrfIdentity, config: HackrfConfiguration): Promise<HackrfConfiguredSession> {
    await this.io.output(48, 0x36, 0); // clear OFF/RX bias-tee overrides
    await this.io.output(1, 0, 0);
    await this.waitStableMode(0);
    await this.setOneRateAndFilter(config);
    await this.io.output(16, 0, 0, hackrfFrequencyPayload(config.centerFrequencyHz));
    await this.setStableRxControls(config);
    return this.oneSession(identity, config);
  }
  private async verifyOneRx(identity: HackrfIdentity, config: HackrfConfiguration): Promise<HackrfConfiguredSession> {
    await this.waitStableMode(2);
    await this.setOneRateAndFilter(config);
    // Same-frequency cache also exists in non-Pro radio.c; force RF reapplication.
    const prime = config.centerFrequencyHz === 6_000_000_000 ? config.centerFrequencyHz - 1 : config.centerFrequencyHz + 1;
    await this.io.output(16, 0, 0, hackrfFrequencyPayload(prime));
    await this.io.output(16, 0, 0, hackrfFrequencyPayload(config.centerFrequencyHz));
    await this.setStableRxControls(config);
    return this.oneSession(identity, config);
  }
  private oneSession(identity: HackrfIdentity, config: HackrfConfiguration): HackrfConfiguredSession {
    const details: HackrfSessionDetails = {
      capabilities: discoverHackrfCapabilities({ identity, descriptorLayoutVerified: true, mandatoryQueriesVerified: true, standardImageIndex: null, standardImageSelectionAcknowledged: false }),
      nativeEncoding: "ci8", nativeSampleRateHz: config.sampleRateHz, effectiveSampleRateHz: 2_400_000,
      adcSampleRateHz: config.sampleRateHz, fpgaDecimationFactor: 1, hostResampling: hostResamplingForRate(config.sampleRateHz), rateEvidence: "requested-and-acknowledged",
      captureSettings: { ...config.settings, requestedCenterFrequencyHz: config.centerFrequencyHz, requestedSampleRateHz: config.sampleRateHz,
        appliedRateFixed36: null, appliedRfFixed24: null, appliedRotation: null, reportedBasebandBandwidthHz: null, reportedAnalogLpfTargetHz: null,
        settingsEvidence: "usb-acknowledged", requestedBasebandBandwidthHz: 7_000_000 },
    };
    validateHackrfSessionDetails(details);
    return { generation: config.generation, hardwareCenterFrequencyHz: config.centerFrequencyHz, details };
  }
  /** API 0x0109/0x0110: use established setters, M0 state and legacy FPGA SPI.
   * Neither the nominal rate nor RF center can be read back on these releases. */
  private async waitStableMode(mode: 0 | 2): Promise<void> {
    await this.poll(async () => {
      const view = await this.io.input(41, 0, 0, 40, 40, this.pollDeadline! - this.io.now());
      if (view.getUint32(0, true) === mode && view.getUint32(4, true) === mode) return true;
    });
  }
  private async setStableRxControls(config: HackrfConfiguration): Promise<void> {
    for (const [request, gain] of [[19, config.settings.rxLnaGainCode], [20, config.settings.rxVgaGainDb]] as const) {
      if ((await this.io.input(request, 0, gain, 1)).getUint8(0) !== 1) throw new Error("HackRF RX gain setter rejected its value.");
    }
    await this.io.output(17, config.settings.rfAmplifierEnabled ? 1 : 0, 0);
    await this.io.output(23, 0, 0);
    await this.io.output(29, 0, 0);
  }
  private async configureStable(identity: HackrfIdentity, config: HackrfConfiguration): Promise<HackrfConfiguredSession> {
    // Clear only OFF/RX bias-tee overrides; this command does not select TX or flash.
    await this.io.output(48, 0x36, 0);
    await this.io.output(1, 0, 0);
    await this.waitStableMode(0);
    await this.io.output(23, 0, 0);
    await this.io.output(54, 0, 0);
    // Standard 8-bit layout: CTRL=1, RX_DECIM=2, TX_CTRL=3, TX_INTRP=4, TX_PSTEP=5.
    // Direct writes also synchronize firmware's register cache after image loading.
    for (const [register, value] of [[1, 1], [2, hackrfDecimationExponent(config.sampleRateHz)], [3, 0], [4, 0], [5, 0]]) {
      await this.io.output(49, value!, register!);
    }
    await this.io.output(6, 0, 0, hackrfRatePayload(config.sampleRateHz));
    await this.io.output(16, 0, 0, hackrfFrequencyPayload(config.centerFrequencyHz));
    await this.setStableRxControls(config);
    return this.stableSession(identity, config, await this.verifyStableFpga(config));
  }
  private async verifyStableRx(identity: HackrfIdentity, config: HackrfConfiguration): Promise<HackrfConfiguredSession> {
    await this.waitStableMode(2);
    // OFF setters only store configuration. Reissue under RX to check actual setter results.
    await this.io.output(6, 0, 0, hackrfRatePayload(config.sampleRateHz));
    // v2026.01.3 caches the last RF frequency across OFF and image loading. Two
    // distinct safe centers force final tuning/filter/quarter-shift application,
    // including same-frequency restart or rate changes. All samples stay discarded.
    const prime = config.centerFrequencyHz === 6_000_000_000 ? config.centerFrequencyHz - 1 : config.centerFrequencyHz + 1;
    await this.io.output(16, 0, 0, hackrfFrequencyPayload(prime));
    await this.io.output(16, 0, 0, hackrfFrequencyPayload(config.centerFrequencyHz));
    await this.setStableRxControls(config);
    return this.stableSession(identity, config, await this.verifyStableFpga(config));
  }
  private async verifyStableFpga(config: HackrfConfiguration): Promise<number> {
    const values: number[] = [];
    for (let register = 1; register <= 5; register++) values.push((await this.io.input(50, 0, register, 1)).getUint8(0));
    if (![1, 3, 7].includes(values[0]!) || values[1] !== (hackrfDecimationExponent(config.sampleRateHz))
      || values.slice(2).some(value => value !== 0)) throw new Error("HackRF stable standard FPGA register verification failed.");
    return values[0]!;
  }
  private stableSession(identity: HackrfIdentity, config: HackrfConfiguration, control: number): HackrfConfiguredSession {
    const factor = hackrfDecimationFactor(config.sampleRateHz);
    const details: HackrfSessionDetails = {
      capabilities: discoverHackrfCapabilities({ identity, descriptorLayoutVerified: true, mandatoryQueriesVerified: true,
        standardImageIndex: 0, standardImageSelectionAcknowledged: true }),
      nativeEncoding: "ci8", nativeSampleRateHz: config.sampleRateHz, effectiveSampleRateHz: channelSampleRate(config.sampleRateHz),
      adcSampleRateHz: config.sampleRateHz * factor, fpgaDecimationFactor: factor,
      hostResampling: hostResamplingForRate(config.sampleRateHz), rateEvidence: "requested-and-acknowledged",
      captureSettings: { ...config.settings, requestedCenterFrequencyHz: config.centerFrequencyHz, requestedSampleRateHz: config.sampleRateHz,
        appliedRateFixed36: null, appliedRfFixed24: null, appliedRotation: null,
        reportedBasebandBandwidthHz: null, reportedAnalogLpfTargetHz: null,
        settingsEvidence: "usb-acknowledged", stableFpgaControl: control },
    };
    validateHackrfSessionDetails(details);
    return { generation: config.generation, hardwareCenterFrequencyHz: config.centerFrequencyHz, details };
  }
  private async reported(identity: HackrfIdentity, config: HackrfConfiguration, receiving: boolean): Promise<HackrfConfiguredSession> {
    const values = await this.poll(async () => {
      const registers = new Map<number, bigint>();
      for (const register of [0, 6, 8, 1, 5, 11, 12, 13, 20, 21, 22, 15, 17]) registers.set(register, await this.read(register));
      const val = (register: number) => registers.get(register)!;
      if ([...registers.values()].includes(UNSET)) return;
      if (val(0) !== (receiving ? 1n : 0n) || val(8) !== (BigInt(hackrfDecimationExponent(config.sampleRateHz)))
        || Math.abs(decodeHackrfFixed(val(6), 36) - config.sampleRateHz) > 1
        || Math.abs(decodeHackrfFixed(val(1), 24) - config.centerFrequencyHz) > 1_000
        || ![0n, 0x40000000n, 0xc0000000n].includes(val(5))
        || val(12) !== BigInt(config.settings.rxLnaGainCode) || val(13) !== BigInt(config.settings.rxVgaGainDb)
        || val(20) !== 0n || val(21) !== 0n || val(22) !== 1n
        || (receiving && val(11) !== BigInt(config.settings.rfAmplifierEnabled ? 1 : 0))) return;
      return registers;
    });
    const rate = decodeHackrfFixed(values.get(6)!, 36);
    if (isWidebandRate(config.sampleRateHz) && rate !== config.sampleRateHz) throw new Error("Wideband profile requires an exact nominal firmware rate.");
    const factor = hackrfDecimationFactor(config.sampleRateHz);
    const details: HackrfSessionDetails = {
      capabilities: discoverHackrfCapabilities({ identity, descriptorLayoutVerified: true, mandatoryQueriesVerified: true,
        standardImageIndex: 0, standardImageSelectionAcknowledged: true }),
      nativeEncoding: "ci8", nativeSampleRateHz: rate, effectiveSampleRateHz: channelSampleRate(rate),
      adcSampleRateHz: rate * factor, fpgaDecimationFactor: factor,
      hostResampling: hostResamplingForRate(config.sampleRateHz), rateEvidence: "firmware-reported",
      captureSettings: { ...config.settings, requestedCenterFrequencyHz: config.centerFrequencyHz, requestedSampleRateHz: config.sampleRateHz,
        appliedRateFixed36: String(values.get(6)), appliedRfFixed24: String(values.get(1)), appliedRotation: Number(values.get(5)),
        reportedBasebandBandwidthHz: Number(values.get(15)), reportedAnalogLpfTargetHz: Number(values.get(17)),
        settingsEvidence: "accepted-and-firmware-reported" },
    };
    validateHackrfSessionDetails(details);
    return { generation: config.generation, hardwareCenterFrequencyHz: decodeHackrfFixed(values.get(1)!, 24), details };
  }
  private async verifyFpga(session: HackrfConfiguredSession, restore: boolean): Promise<void> {
    const expected = [1, hackrfDecimationExponent(session.details.captureSettings.requestedSampleRateHz), session.details.captureSettings.appliedRotation! / 2 ** 24, 0, 0, 0];
    for (let index = 0; index < expected.length; index++) {
      if (restore) await this.io.output(49, expected[index]!, index + 1);
      if ((await this.io.input(50, 0, index + 1, 1)).getUint8(0) !== expected[index]) throw new Error("HackRF standard FPGA register verification failed.");
    }
  }
}

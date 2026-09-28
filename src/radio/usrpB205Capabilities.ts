/** Frozen, receive-only source contract for the UHD 4.9.0.0 B205-mini profile. */
export const USRP_B205_PROTOCOL_PROFILE = "usrp-b205-mini-uhd-4.9.0.0-rx-v2" as const;
export const USRP_B205_UHD_COMMIT = "006d7f7646fb66f2ae635cb44ef6442a6ad4fba7" as const;
export const USRP_B205_FPGA_SHA256 = "f4da0becf906af957c954a7a1c276aa91f79ca369d7aedf7c2f5c7fdebf4c351" as const;
export const USRP_B205_SAMPLE_RATE_HZ = 4_800_000 as const;
export const USRP_B205_HIGH_SAMPLE_RATE_HZ = 9_600_000 as const;
export const USRP_B205_EXPERIMENTAL_SAMPLE_RATE_HZ = 19_200_000 as const;
export const USRP_B205_SAMPLE_RATES_HZ = [
  USRP_B205_SAMPLE_RATE_HZ,
  USRP_B205_HIGH_SAMPLE_RATE_HZ,
  USRP_B205_EXPERIMENTAL_SAMPLE_RATE_HZ,
] as const;
export type UsrpB205SampleRateHz = typeof USRP_B205_SAMPLE_RATES_HZ[number];
export const USRP_B205_EFFECTIVE_SAMPLE_RATE_HZ = 2_400_000 as const;
export const USRP_B205_MASTER_CLOCK_RATE_HZ = 38_400_000 as const;
export const USRP_B205_BANDWIDTH_HZ = 4_800_000 as const;
export const USRP_B205_FPGA_DECIMATION = 8 as const;
export const USRP_B205_TIMESTAMP_TICKS_PER_SAMPLE = 8 as const;

export function usrpB205RateProfile(sampleRateHz: number): Readonly<{
  sampleRateHz: UsrpB205SampleRateHz;
  bandwidthHz: UsrpB205SampleRateHz;
  fpgaDecimation: 2 | 4 | 8;
  timestampTicksPerSample: 2 | 4 | 8;
  dspDecimationRegister: 0x201 | 0x301 | 0x302;
}> {
  if (!USRP_B205_SAMPLE_RATES_HZ.includes(sampleRateHz as UsrpB205SampleRateHz))
    throw new Error("USRP B205-mini native rate must be 4800000, 9600000 or 19200000 samples/s.");
  return sampleRateHz === USRP_B205_EXPERIMENTAL_SAMPLE_RATE_HZ
    ? { sampleRateHz, bandwidthHz: sampleRateHz, fpgaDecimation: 2, timestampTicksPerSample: 2, dspDecimationRegister: 0x201 }
    : sampleRateHz === USRP_B205_HIGH_SAMPLE_RATE_HZ
    ? { sampleRateHz, bandwidthHz: sampleRateHz, fpgaDecimation: 4, timestampTicksPerSample: 4, dspDecimationRegister: 0x301 }
    : { sampleRateHz: USRP_B205_SAMPLE_RATE_HZ, bandwidthHz: USRP_B205_BANDWIDTH_HZ, fpgaDecimation: 8, timestampTicksPerSample: 8, dspDecimationRegister: 0x302 };
}

export interface UsrpB205RxSettings {
  kind: "usrp-b205";
  antenna: "RX2";
  clockSource: "internal";
  timeSource: "internal";
  gainMode: "slow_agc";
  /** Slow AGC exposes no requested or calibrated gain value. */
  gainDb: null;
}

export const DEFAULT_USRP_B205_RX_SETTINGS: Readonly<UsrpB205RxSettings> = Object.freeze({
  kind: "usrp-b205",
  antenna: "RX2",
  clockSource: "internal",
  timeSource: "internal",
  gainMode: "slow_agc",
  gainDb: null,
});

export interface UsrpB205Identity {
  kind: "usrp-b205-mini";
  vendorId: 0x2500;
  productId: 0x0022;
  productName: string;
  serialNumber: string | null;
}

export interface UsrpB205RuntimeEvidence {
  identity: UsrpB205Identity;
  descriptorLayoutVerified: boolean;
  firmware: { major: number; minor: number };
  usbSpeed: 3;
  fpga: {
    signature: 0xace0ba5e;
    compatibilityMajor: number;
    compatibilityMinor: number;
    imageSha256: string;
    legacyHash: number;
  };
}

export interface UsrpB205DiscoveredCapabilities {
  source: "usrp-b205";
  phase: "discovered";
  protocolProfile: typeof USRP_B205_PROTOCOL_PROFILE;
  uhdReferenceCommit: typeof USRP_B205_UHD_COMMIT;
  identity: UsrpB205Identity;
  descriptorLayoutVerified: true;
  firmware: { major: 8; minor: number };
  fpga: {
    signature: 0xace0ba5e;
    compatibilityMajor: 7;
    compatibilityMinor: number;
    imageSha256: typeof USRP_B205_FPGA_SHA256;
    legacyHash: 0x1624155e;
  };
  usbSpeed: "super-speed";
  nativeEncoding: "chdr-vrt-sc16-le";
  sampleWordOrder: "i16-msw-q16-lsw";
  sampleByteOrder: "q-lo-q-hi-i-lo-i-hi";
  sampleScaling: "float=int16*0.9999997558594347/32767";
  hardwareValidation: "pending";
}

export interface UsrpB205RequestedConfiguration extends UsrpB205RxSettings {
  requestedCenterFrequencyHz: number;
  requestedSampleRateHz: UsrpB205SampleRateHz;
  requestedBandwidthHz: UsrpB205SampleRateHz;
}

export interface UsrpB205AcceptedConfiguration {
  requested: UsrpB205RequestedConfiguration;
  acceptedCenterFrequencyHz: number;
  centerFrequencyEvidence: "rf-synthesizer-calculated";
  acceptedSampleRateHz: UsrpB205SampleRateHz;
  sampleRateEvidence: "ddc-calculated";
  acceptedBandwidthHz: number;
  bandwidthEvidence: "ad9361-readback";
  acceptedMasterClockRateHz: typeof USRP_B205_MASTER_CLOCK_RATE_HZ;
  masterClockEvidence: "rf-driver-calculated";
  acceptedAntenna: "RX2";
  acceptedClockSource: "internal";
  acceptedTimeSource: "internal";
  acceptedGainMode: "slow_agc";
  /** No manual/calibrated gain is exposed by the frozen AGC profile. */
  acceptedGainDb: null;
}

export interface UsrpB205SessionDetails {
  capabilities: UsrpB205DiscoveredCapabilities;
  nativeEncoding: "chdr-vrt-sc16-le";
  nativeSampleRateHz: UsrpB205SampleRateHz;
  effectiveSampleRateHz: typeof USRP_B205_EFFECTIVE_SAMPLE_RATE_HZ;
  configuration: UsrpB205AcceptedConfiguration;
  observations: {
    ad9364DeviceIdVerified: true;
    rxPllLocked: true;
    timestampRateValidation: "pending" | "observed";
  };
  hardwareValidation: "pending";
}

const printable = (value: string): boolean => /^[\x20-\x7e]{1,128}$/.test(value);
const versionByte = (value: number): boolean => Number.isInteger(value) && value >= 0 && value <= 0xff;
const versionWord = (value: number): boolean => Number.isInteger(value) && value >= 0 && value <= 0xffff;

export function validateUsrpB205RxSettings(settings: UsrpB205RxSettings): UsrpB205RxSettings {
  if (settings.kind !== "usrp-b205" || settings.antenna !== "RX2"
    || settings.clockSource !== "internal" || settings.timeSource !== "internal"
    || settings.gainMode !== "slow_agc" || settings.gainDb !== null) {
    throw new Error("USRP B205-mini release 1 requires RX2, internal clock/time and slow-attack AGC with no manual gain.");
  }
  return { ...settings };
}

export function createUsrpB205RequestedConfiguration(
  centerFrequencyHz: number,
  sampleRateHz: number = USRP_B205_SAMPLE_RATE_HZ,
): UsrpB205RequestedConfiguration {
  validateUsrpCenterFrequency(centerFrequencyHz);
  const profile = usrpB205RateProfile(sampleRateHz);
  return {
    ...DEFAULT_USRP_B205_RX_SETTINGS,
    requestedCenterFrequencyHz: centerFrequencyHz,
    requestedSampleRateHz: profile.sampleRateHz,
    requestedBandwidthHz: profile.bandwidthHz,
  };
}

export function discoverUsrpB205Capabilities(evidence: UsrpB205RuntimeEvidence): UsrpB205DiscoveredCapabilities {
  const { identity, firmware, fpga } = evidence;
  if (identity.kind !== "usrp-b205-mini" || identity.vendorId !== 0x2500 || identity.productId !== 0x0022
    || !printable(identity.productName) || (identity.serialNumber !== null && !printable(identity.serialNumber))
    || evidence.descriptorLayoutVerified !== true || evidence.usbSpeed !== 3
    || firmware.major !== 8 || !versionByte(firmware.minor)
    || fpga.signature !== 0xace0ba5e || fpga.compatibilityMajor !== 7 || !versionWord(fpga.compatibilityMinor)
    || fpga.imageSha256 !== USRP_B205_FPGA_SHA256 || fpga.legacyHash !== 0x1624155e) {
    throw new Error("USRP B205-mini requires runtime 2500:0022, verified USB 3 descriptors, FX3 8.x and the pinned FPGA 7.x image.");
  }
  return {
    source: "usrp-b205", phase: "discovered", protocolProfile: USRP_B205_PROTOCOL_PROFILE,
    uhdReferenceCommit: USRP_B205_UHD_COMMIT,
    identity: { ...identity }, descriptorLayoutVerified: true, firmware: { major: 8, minor: firmware.minor },
    fpga: { signature: 0xace0ba5e, compatibilityMajor: 7, compatibilityMinor: fpga.compatibilityMinor,
      imageSha256: USRP_B205_FPGA_SHA256, legacyHash: 0x1624155e },
    usbSpeed: "super-speed", nativeEncoding: "chdr-vrt-sc16-le",
    sampleWordOrder: "i16-msw-q16-lsw", sampleByteOrder: "q-lo-q-hi-i-lo-i-hi",
    sampleScaling: "float=int16*0.9999997558594347/32767", hardwareValidation: "pending",
  };
}

function validateUsrpCenterFrequency(value: number): void {
  if (!Number.isFinite(value) || !Number.isSafeInteger(value) || value < 70_000_000 || value > 6_000_000_000) {
    throw new Error("USRP B205-mini center frequency must be a safe integer from 70000000 to 6000000000 Hz.");
  }
}

/** Validates metadata consistency, not the hardware observations that produce it. */
export function validateUsrpB205SessionDetails(details: UsrpB205SessionDetails): void {
  const caps = details.capabilities;
  const accepted = details.configuration;
  discoverUsrpB205Capabilities({
    identity: caps.identity,
    descriptorLayoutVerified: caps.descriptorLayoutVerified,
    firmware: caps.firmware,
    usbSpeed: 3,
    fpga: caps.fpga,
  });
  validateUsrpB205RxSettings(accepted.requested);
  validateUsrpCenterFrequency(accepted.requested.requestedCenterFrequencyHz);
  validateUsrpCenterFrequency(accepted.acceptedCenterFrequencyHz);
  const rate = usrpB205RateProfile(accepted.requested.requestedSampleRateHz);
  if (caps.source !== "usrp-b205" || caps.phase !== "discovered"
    || caps.protocolProfile !== USRP_B205_PROTOCOL_PROFILE || caps.uhdReferenceCommit !== USRP_B205_UHD_COMMIT
    || caps.descriptorLayoutVerified !== true || caps.nativeEncoding !== "chdr-vrt-sc16-le"
    || caps.sampleWordOrder !== "i16-msw-q16-lsw" || caps.sampleByteOrder !== "q-lo-q-hi-i-lo-i-hi"
    || caps.sampleScaling !== "float=int16*0.9999997558594347/32767"
    || details.nativeEncoding !== "chdr-vrt-sc16-le"
    || details.nativeSampleRateHz !== rate.sampleRateHz || details.effectiveSampleRateHz !== USRP_B205_EFFECTIVE_SAMPLE_RATE_HZ
    || accepted.requested.requestedBandwidthHz !== rate.bandwidthHz
    || accepted.acceptedSampleRateHz !== rate.sampleRateHz || accepted.sampleRateEvidence !== "ddc-calculated"
    || !Number.isSafeInteger(accepted.acceptedBandwidthHz) || accepted.acceptedBandwidthHz <= 0
    || accepted.bandwidthEvidence !== "ad9361-readback"
    || accepted.acceptedMasterClockRateHz !== USRP_B205_MASTER_CLOCK_RATE_HZ || accepted.masterClockEvidence !== "rf-driver-calculated"
    || accepted.centerFrequencyEvidence !== "rf-synthesizer-calculated"
    || accepted.acceptedAntenna !== "RX2" || accepted.acceptedClockSource !== "internal"
    || accepted.acceptedTimeSource !== "internal" || accepted.acceptedGainMode !== "slow_agc" || accepted.acceptedGainDb !== null
    || details.observations.ad9364DeviceIdVerified !== true || details.observations.rxPllLocked !== true
    || !["pending", "observed"].includes(details.observations.timestampRateValidation)
    || details.hardwareValidation !== "pending") {
    throw new Error("USRP B205-mini session metadata does not match the frozen receive-only profile.");
  }
}

export type UsrpB205AcceptedChangeBoundary =
  | { kind: "none"; acquisitionGeneration: "unchanged"; recordingBoundary: "none" }
  | { kind: "retune"; acquisitionGeneration: "increment-before-command"; recordingBoundary: "metadata-change"; publishMetadata: "after-accepted" }
  | { kind: "full-session-close"; acquisitionGeneration: "invalidate"; recordingBoundary: "metadata-change"; publishMetadata: "after-reconnect" };

/** Center-only changes use the retune boundary; drift in any frozen field closes the session. */
export function usrpB205AcceptedChangeBoundary(
  previous: UsrpB205AcceptedConfiguration,
  next: UsrpB205AcceptedConfiguration,
): UsrpB205AcceptedChangeBoundary {
  if (JSON.stringify(previous) === JSON.stringify(next)) return { kind: "none", acquisitionGeneration: "unchanged", recordingBoundary: "none" };
  const withoutCenter = (value: UsrpB205AcceptedConfiguration) => ({
    ...value,
    requested: { ...value.requested, requestedCenterFrequencyHz: 0 },
    acceptedCenterFrequencyHz: 0,
  });
  if (JSON.stringify(withoutCenter(previous)) === JSON.stringify(withoutCenter(next))) {
    return { kind: "retune", acquisitionGeneration: "increment-before-command", recordingBoundary: "metadata-change", publishMetadata: "after-accepted" };
  }
  return { kind: "full-session-close", acquisitionGeneration: "invalidate", recordingBoundary: "metadata-change", publishMetadata: "after-reconnect" };
}

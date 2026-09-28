import { describe, expect, it } from "vitest";
import { defaultModeSettings, RECEIVER_MODES } from "./receiverConfig";
import { validateOptions } from "./receiverController";
import { sourceCapabilities, validateSourceFrequency, validateSourceRoute } from "./sourceCapabilities";
import { sourcePreferenceDefaults } from "./sourcePreferences";
import {
  DEFAULT_USRP_B205_RX_SETTINGS,
  USRP_B205_FPGA_SHA256,
  createUsrpB205RequestedConfiguration,
  discoverUsrpB205Capabilities,
  usrpB205AcceptedChangeBoundary,
  validateUsrpB205RxSettings,
  validateUsrpB205SessionDetails,
  type UsrpB205AcceptedConfiguration,
  type UsrpB205RuntimeEvidence,
  type UsrpB205SessionDetails,
} from "./usrpB205Capabilities";

function evidence(): UsrpB205RuntimeEvidence {
  return {
    identity: { kind: "usrp-b205-mini", vendorId: 0x2500, productId: 0x0022, productName: "USRP B205-mini", serialNumber: "31ABC12" },
    descriptorLayoutVerified: true,
    firmware: { major: 8, minor: 0 },
    usbSpeed: 3,
    fpga: { signature: 0xace0ba5e, compatibilityMajor: 7, compatibilityMinor: 0,
      imageSha256: USRP_B205_FPGA_SHA256, legacyHash: 0x1624155e },
  };
}

function configuration(center = 100_000_000): UsrpB205AcceptedConfiguration {
  return {
    requested: createUsrpB205RequestedConfiguration(center),
    acceptedCenterFrequencyHz: center,
    centerFrequencyEvidence: "rf-synthesizer-calculated",
    acceptedSampleRateHz: 4_800_000,
    sampleRateEvidence: "ddc-calculated",
    acceptedBandwidthHz: 4_799_998,
    bandwidthEvidence: "ad9361-readback",
    acceptedMasterClockRateHz: 38_400_000,
    masterClockEvidence: "rf-driver-calculated",
    acceptedAntenna: "RX2",
    acceptedClockSource: "internal",
    acceptedTimeSource: "internal",
    acceptedGainMode: "slow_agc",
    acceptedGainDb: null,
  };
}

function details(): UsrpB205SessionDetails {
  return {
    capabilities: discoverUsrpB205Capabilities(evidence()),
    nativeEncoding: "chdr-vrt-sc16-le",
    nativeSampleRateHz: 4_800_000,
    effectiveSampleRateHz: 2_400_000,
    configuration: configuration(),
    observations: { ad9364DeviceIdVerified: true, rxPllLocked: true, timestampRateValidation: "pending" },
    hardwareValidation: "pending",
  };
}

describe("USRP B205-mini source contract", () => {
  it("keeps fixed pre-connect defaults separate from discovered identity", () => {
    expect(sourceCapabilities("usrp-b205")).toMatchObject({
      label: "USRP B205-mini", requiresUsb: true, persistentConnection: true,
      rates: { valuesHz: [4_800_000, 9_600_000, 19_200_000], defaultHz: 4_800_000,
        experimentalHz: [19_200_000] },
      gain: { kind: "usrp-fixed-agc", mode: "slow_agc", exposedGainDb: false },
    });
    expect(sourcePreferenceDefaults("usrp-b205")).toEqual({
      frequencyHz: 100_000_000, modeSettings: defaultModeSettings("WBFM"), sampleRateHz: 4_800_000,
      usrpSettings: DEFAULT_USRP_B205_RX_SETTINGS,
    });
    expect(discoverUsrpB205Capabilities(evidence())).toMatchObject({
      source: "usrp-b205", phase: "discovered", usbSpeed: "super-speed",
      nativeEncoding: "chdr-vrt-sc16-le", sampleWordOrder: "i16-msw-q16-lsw",
      sampleByteOrder: "q-lo-q-hi-i-lo-i-hi", sampleScaling: "float=int16*0.9999997558594347/32767",
      hardwareValidation: "pending",
    });
  });

  it("validates inclusive tuning bounds, safe integers and complete channel passbands", () => {
    for (const frequency of [70_000_000, 4_300_000_001, 6_000_000_000]) {
      expect(() => validateSourceFrequency("usrp-b205", frequency)).not.toThrow();
    }
    for (const frequency of [NaN, Infinity, -Infinity, 69_999_999, 6_000_000_001, 4_300_000_000.5, Number.MAX_SAFE_INTEGER + 1]) {
      expect(() => validateSourceFrequency("usrp-b205", frequency)).toThrow();
    }
    expect(() => validateSourceRoute("usrp-b205", defaultModeSettings("WBFM"), 4_800_000, 70_075_000)).not.toThrow();
    expect(() => validateSourceRoute("usrp-b205", defaultModeSettings("WBFM"), 4_800_000, 70_074_999)).toThrow(/passband/);
    expect(() => validateSourceRoute("usrp-b205", defaultModeSettings("WBFM"), 4_800_000, 5_999_925_000)).not.toThrow();
    expect(() => validateSourceRoute("usrp-b205", defaultModeSettings("WBFM"), 4_800_000, 5_999_925_001)).toThrow(/passband/);
  });

  it("accepts every existing receiver mode at each exact rate", () => {
    for (const sampleRateHz of [4_800_000, 9_600_000, 19_200_000]) for (const mode of RECEIVER_MODES) {
      expect(() => validateOptions({ source: "usrp-b205", channelFrequencyHz: 1_500_000_000,
        volume: 0.5, sampleRateHz, modeSettings: defaultModeSettings(mode),
        usrpSettings: { ...DEFAULT_USRP_B205_RX_SETTINGS } })).not.toThrow();
    }
    for (const sampleRateHz of [1_024_000, 2_400_000, 4_799_999, 4_800_001, 9_599_999, 9_600_001, 19_199_999, 19_200_001, NaN, Infinity]) {
      expect(() => validateOptions({ source: "usrp-b205", channelFrequencyHz: 100_000_000, volume: 0.5, sampleRateHz })).toThrow();
    }
    expect(createUsrpB205RequestedConfiguration(100_000_000, 9_600_000)).toMatchObject({
      requestedSampleRateHz: 9_600_000,
      requestedBandwidthHz: 9_600_000,
    });
    expect(createUsrpB205RequestedConfiguration(100_000_000, 19_200_000)).toMatchObject({
      requestedSampleRateHz: 19_200_000,
      requestedBandwidthHz: 19_200_000,
    });
  });

  it("makes TX, manual gain, alternate antenna and external timing unrepresentable and rejects forged input", () => {
    expect(validateUsrpB205RxSettings({ ...DEFAULT_USRP_B205_RX_SETTINGS })).toEqual(DEFAULT_USRP_B205_RX_SETTINGS);
    for (const patch of [{ antenna: "TX/RX" }, { clockSource: "external" }, { timeSource: "external" },
      { gainMode: "manual" }, { gainDb: 10 }, { kind: "usrp-b200" }]) {
      expect(() => validateUsrpB205RxSettings({ ...DEFAULT_USRP_B205_RX_SETTINGS, ...patch } as never)).toThrow();
    }
    expect(() => validateOptions({ source: "usrp-b205", channelFrequencyHz: 100_000_000, volume: 0.5, gainDb: null })).toThrow(/fixed/);
    expect(() => validateOptions({ source: "usrp-b205", channelFrequencyHz: 100_000_000, volume: 0.5,
      hardwareSettings: { kind: "hackrf", rxLnaGainCode: 16, rxVgaGainDb: 12, rfAmplifierEnabled: false, antennaPowerEnabled: false } })).toThrow(/HackRF/);
  });

  it("rejects incompatible runtime product, firmware, USB and FPGA evidence", () => {
    for (const mutate of [
      (value: UsrpB205RuntimeEvidence) => { value.identity = { ...value.identity, productId: 0x0021 } as never; },
      (value: UsrpB205RuntimeEvidence) => { value.descriptorLayoutVerified = false; },
      (value: UsrpB205RuntimeEvidence) => { value.firmware.major = 7; },
      (value: UsrpB205RuntimeEvidence) => { value.usbSpeed = 2 as never; },
      (value: UsrpB205RuntimeEvidence) => { value.fpga.compatibilityMajor = 6; },
      (value: UsrpB205RuntimeEvidence) => { value.fpga.imageSha256 = "0".repeat(64); },
    ]) {
      const value = evidence(); mutate(value);
      expect(() => discoverUsrpB205Capabilities(value)).toThrow(/requires runtime/);
    }
  });

  it("keeps requested, calculated, read-back and observed metadata distinct", () => {
    const valid = details();
    expect(() => validateUsrpB205SessionDetails(valid)).not.toThrow();
    expect(valid.configuration.requested.requestedCenterFrequencyHz).toBe(100_000_000);
    expect(valid.configuration.centerFrequencyEvidence).toBe("rf-synthesizer-calculated");
    expect(valid.configuration.bandwidthEvidence).toBe("ad9361-readback");
    expect(valid.configuration.acceptedBandwidthHz).not.toBe(valid.configuration.requested.requestedBandwidthHz);
    for (const changed of [
      { nativeSampleRateHz: 2_399_999 }, { effectiveSampleRateHz: 2_399_999 }, { nativeEncoding: "ci16" },
      { hardwareValidation: "observed" },
    ]) expect(() => validateUsrpB205SessionDetails({ ...valid, ...changed } as never)).toThrow();
    expect(() => validateUsrpB205SessionDetails({ ...valid, configuration: { ...valid.configuration,
      sampleRateEvidence: "read-back" } } as never)).toThrow();
  });

  it("defines generation, recording and metadata publication boundaries", () => {
    const before = configuration();
    expect(usrpB205AcceptedChangeBoundary(before, structuredClone(before))).toEqual({
      kind: "none", acquisitionGeneration: "unchanged", recordingBoundary: "none",
    });
    expect(usrpB205AcceptedChangeBoundary(before, configuration(4_300_000_001))).toEqual({
      kind: "retune", acquisitionGeneration: "increment-before-command", recordingBoundary: "metadata-change", publishMetadata: "after-accepted",
    });
    expect(usrpB205AcceptedChangeBoundary(before, { ...before, acceptedBandwidthHz: 2_399_997 })).toEqual({
      kind: "full-session-close", acquisitionGeneration: "invalidate", recordingBoundary: "metadata-change", publishMetadata: "after-reconnect",
    });
  });
});

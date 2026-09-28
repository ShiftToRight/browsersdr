import {
  USRP_B205_EFFECTIVE_SAMPLE_RATE_HZ,
  USRP_B205_FPGA_SHA256,
  USRP_B205_SAMPLE_RATE_HZ,
  usrpB205RateProfile,
  type UsrpB205SampleRateHz,
  createUsrpB205RequestedConfiguration,
  discoverUsrpB205Capabilities,
  type UsrpB205SessionDetails,
} from "../radio/usrpB205Capabilities";

export function usrpB205SessionDetails(
  center = 100_000_000,
  sampleRateHz: UsrpB205SampleRateHz = USRP_B205_SAMPLE_RATE_HZ,
): UsrpB205SessionDetails {
  const rate = usrpB205RateProfile(sampleRateHz);
  return {
    capabilities: discoverUsrpB205Capabilities({
      identity: { kind: "usrp-b205-mini", vendorId: 0x2500, productId: 0x0022,
        productName: "USRP B205-mini fixture", serialNumber: "FIXTURE" },
      descriptorLayoutVerified: true, firmware: { major: 8, minor: 0 }, usbSpeed: 3,
      fpga: { signature: 0xace0ba5e, compatibilityMajor: 7, compatibilityMinor: 0,
        imageSha256: USRP_B205_FPGA_SHA256, legacyHash: 0x1624155e },
    }),
    nativeEncoding: "chdr-vrt-sc16-le", nativeSampleRateHz: rate.sampleRateHz,
    effectiveSampleRateHz: USRP_B205_EFFECTIVE_SAMPLE_RATE_HZ,
    configuration: {
      requested: createUsrpB205RequestedConfiguration(center, rate.sampleRateHz),
      acceptedCenterFrequencyHz: center, centerFrequencyEvidence: "rf-synthesizer-calculated",
      acceptedSampleRateHz: rate.sampleRateHz, sampleRateEvidence: "ddc-calculated",
      acceptedBandwidthHz: rate.bandwidthHz - 2, bandwidthEvidence: "ad9361-readback",
      acceptedMasterClockRateHz: 38_400_000, masterClockEvidence: "rf-driver-calculated",
      acceptedAntenna: "RX2", acceptedClockSource: "internal", acceptedTimeSource: "internal",
      acceptedGainMode: "slow_agc", acceptedGainDb: null,
    },
    observations: { ad9364DeviceIdVerified: true, rxPllLocked: true, timestampRateValidation: "pending" },
    hardwareValidation: "pending",
  };
}

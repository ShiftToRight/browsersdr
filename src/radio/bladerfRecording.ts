import {
  assertBladeRfMicroModel,
  bladeRfModelValidation,
} from "./bladerfModels";
import { selectBladeRfImage } from "./bladerfImages";
import {
  BLADERF_REFERENCE_COMMIT,
  bladeRfProtocolProfile,
  type BladeRfSessionDetails,
} from "./bladerfProtocol";
import {
  BLADERF_SAMPLE_RATES_HZ,
  channelSampleRate,
} from "./sourceCapabilities";
import { validateBladeRfRxSettings } from "./bladerfSettings";

/** Distinct from full-scale USRP CI16: native bladeRF words carry SC16 Q11. */
export const BLADERF_SC16_RECORDING_FORMAT =
  "browsersdr-bladerf-sc16-q11-v1" as const;
export const BLADERF_SC16_NORMALIZATION = "float = int16 / 2048" as const;

export interface BladeRfSc16RecordingFormat {
  format: typeof BLADERF_SC16_RECORDING_FORMAT;
  sampleEncoding: "signed-16-bit-little-endian";
  sampleOrder: "interleaved-iq";
  bytesPerComplexSample: 4;
  normalization: typeof BLADERF_SC16_NORMALIZATION;
  /** Nominal rate used by fixed DSP profiles; capture time uses RFIC readback. */
  nativeSampleRateHz: number;
  effectiveSampleRateHz: number;
  rateEvidence: "rfic-readback";
  hardware: BladeRfSessionDetails;
  provenanceDetails: {
    originalSource: "bladerf";
    datasetProcessing: "native-usb-iq-words-unchanged";
    timestampBasis: "host-first-retained-block";
    hardwareValidation: "pending";
    continuityEvidence: "host-accounting-only";
  };
}

export function bladeRfSc16RecordingFormat(
  details: BladeRfSessionDetails,
): BladeRfSc16RecordingFormat {
  const format: BladeRfSc16RecordingFormat = {
    format: BLADERF_SC16_RECORDING_FORMAT,
    sampleEncoding: "signed-16-bit-little-endian",
    sampleOrder: "interleaved-iq",
    bytesPerComplexSample: 4,
    normalization: BLADERF_SC16_NORMALIZATION,
    nativeSampleRateHz: details.nativeSampleRateHz,
    effectiveSampleRateHz: details.effectiveSampleRateHz,
    rateEvidence: "rfic-readback",
    hardware: structuredClone(details),
    provenanceDetails: {
      originalSource: "bladerf",
      datasetProcessing: "native-usb-iq-words-unchanged",
      timestampBasis: "host-first-retained-block",
      hardwareValidation: "pending",
      continuityEvidence: "host-accounting-only",
    },
  };
  validateBladeRfSc16Format(
    format,
    "bladerf",
    details.acceptedSampleRateHz,
    details.acceptedCenterFrequencyHz,
  );
  return format;
}

export function validateBladeRfSc16Format(
  format: BladeRfSc16RecordingFormat,
  source: string,
  rate: number,
  center: number,
): void {
  const details = format.hardware;
  if (!details?.identity)
    throw new Error("Invalid bladeRF Q11 recording hardware evidence.");
  assertBladeRfMicroModel(details.identity.model);
  const image = selectBladeRfImage(
    details.identity.model,
    details.identity.firmware,
  );
  const provenance = format.provenanceDetails;
  const detection = details.identity.detection;
  const flashSizes: Record<string, number> = {
    "194:54": 4_194_304,
    "239:21": 4_194_304,
    "239:22": 8_388_608,
    "239:23": 16_777_216,
    "31:71": 4_194_304,
  };
  const crc = { xA4: 0xa03b, xA5: 0xb01a, xA9: 0x7196 }[details.identity.model];
  if (
    !detection ||
    detection.source !== "firmware-calibration-cache" ||
    detection.calibrationField !== "B" ||
    detection.calibrationValue !== details.identity.model.slice(1) ||
    detection.calibrationCrc16 !== crc ||
    !Number.isInteger(detection.calibrationRecordOffset) ||
    detection.calibrationRecordOffset < 0 ||
    detection.calibrationRecordOffset > 250 ||
    detection.temperatureGrade !== "unknown" ||
    !detection.flash ||
    detection.flash.pageBytes !== 256 ||
    detection.flash.eraseBlockBytes !== 65_536 ||
    !Number.isInteger(detection.flash.manufacturerId) ||
    !Number.isInteger(detection.flash.deviceId) ||
    flashSizes[
      `${detection.flash.manufacturerId}:${detection.flash.deviceId}`
    ] === undefined ||
    flashSizes[
      `${detection.flash.manufacturerId}:${detection.flash.deviceId}`
    ] !== detection.flash.totalBytes ||
    details.identity.vendorId !== 0x2cf0 ||
    details.identity.productId !== 0x5250 ||
    ![512, 1024].includes(details.identity.usbPacketSize) ||
    (details.identity.serialNumber !== null &&
      (typeof details.identity.serialNumber !== "string" ||
        details.identity.serialNumber.length > 1024))
  )
    throw new Error(
      "Invalid or contradictory bladeRF recording identity evidence.",
    );
  const fpga = details.identity.fpga;
  const volatileImage = details.identity.volatileImage;
  if (
    (source !== "bladerf" && source !== "replay") ||
    format.format !== BLADERF_SC16_RECORDING_FORMAT ||
    format.sampleEncoding !== "signed-16-bit-little-endian" ||
    format.sampleOrder !== "interleaved-iq" ||
    format.bytesPerComplexSample !== 4 ||
    format.normalization !== BLADERF_SC16_NORMALIZATION ||
    format.rateEvidence !== "rfic-readback" ||
    !BLADERF_SAMPLE_RATES_HZ.some(
      (value) => value === format.nativeSampleRateHz,
    ) ||
    format.nativeSampleRateHz !== details.nativeSampleRateHz ||
    format.effectiveSampleRateHz !==
      channelSampleRate(format.nativeSampleRateHz) ||
    details.effectiveSampleRateHz !== format.effectiveSampleRateHz ||
    ![
      rate,
      center,
      details.requestedCenterFrequencyHz,
      details.requestedBandwidthHz,
      details.acceptedBandwidthHz,
    ].every((value) => Number.isFinite(value) && value > 0) ||
    details.acceptedSampleRateHz !== rate ||
    details.acceptedCenterFrequencyHz !== center ||
    Math.abs(rate - format.nativeSampleRateHz) >
      format.nativeSampleRateHz * 0.001 ||
    Math.abs(center - details.requestedCenterFrequencyHz) > 100 ||
    Math.abs(details.acceptedBandwidthHz - details.requestedBandwidthHz) >
      details.requestedBandwidthHz * 0.001 ||
    details.nativeEncoding !== "ci16_le_sc11" ||
    details.hardwareValidation !== "pending" ||
    details.referenceCommit !== BLADERF_REFERENCE_COMMIT ||
    details.protocolProfile !==
      bladeRfProtocolProfile(details.identity.model) ||
    details.identity.kind !==
      `bladerf-2-micro-${details.identity.model.toLowerCase()}` ||
    details.identity.variantValidation !==
      bladeRfModelValidation(details.identity.model) ||
    !fpga ||
    fpga.major !== 0 ||
    (image.version === "0.15.3"
      ? fpga.minor !== 15 ||
        !Number.isInteger(fpga.patch) ||
        fpga.patch < 0 ||
        fpga.patch > 3
      : fpga.minor !== 16 || fpga.patch !== 0) ||
    (volatileImage !== null &&
      (!volatileImage ||
        volatileImage.model !== image.model ||
        volatileImage.version !== image.version ||
        volatileImage.sha256 !== image.sha256 ||
        `${fpga.major}.${fpga.minor}.${fpga.patch}` !== image.version)) ||
    provenance?.originalSource !== "bladerf" ||
    provenance.datasetProcessing !== "native-usb-iq-words-unchanged" ||
    provenance.timestampBasis !== "host-first-retained-block" ||
    provenance.hardwareValidation !== "pending" ||
    provenance.continuityEvidence !== "host-accounting-only"
  )
    throw new Error("Invalid bladeRF SC16 Q11 recording format or provenance.");
  if (!details.rxSettings)
    throw new Error("Missing bladeRF recording receive settings.");
  if (details.rxSettings) {
    const settings = validateBladeRfRxSettings(details.rxSettings, center);
    if (
      details.rxInput !== settings.rxInput ||
      details.gainMode !== settings.gainMode ||
      details.requestedGainDb !==
        (settings.gainMode === "manual" ? settings.manualGainDb : null) ||
      (settings.gainMode === "manual"
        ? !Number.isFinite(details.acceptedGainDb) ||
          Math.abs(details.acceptedGainDb! - settings.manualGainDb) > 1
        : details.acceptedGainDb !== null)
    )
      throw new Error("Invalid bladeRF recording receive input/gain evidence.");
  }
}

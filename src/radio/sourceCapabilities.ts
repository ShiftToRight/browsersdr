import type { SourceKind } from "./types";
import {
  defaultModeSettings, normalizeGain, normalizeModeSettings, planChannelTune,
  RECEIVER_MODES, validateModeSampleRate, type ReceiverMode, type ReceiverModeSettings,
} from "./receiverConfig";

/** Frozen step-01 profile, not a claim about the firmware shipped on a device. */
export const HACKRF_PROTOCOL_PROFILE = "hackrf-pro-standard-7f96cc8-v1" as const;
export const HACKRF_REFERENCE_COMMIT = "7f96cc8e3fa625c4263a71ba8dd44d1f6110e4fa" as const;
export const HACKRF_STABLE_PROFILE = "hackrf-pro-stable-2026-v1" as const;
export const HACKRF_STABLE_REFERENCE_COMMIT = "1cfe7dfe98d333450217d50e3f3a1ad0702e000f" as const;
export type HackrfProtocolProfile = typeof HACKRF_PROTOCOL_PROFILE | typeof HACKRF_STABLE_PROFILE;
export type HackrfReferenceCommit = typeof HACKRF_REFERENCE_COMMIT | typeof HACKRF_STABLE_REFERENCE_COMMIT;
export const isStableHackrfApi = (api: number): boolean => api === 0x0109 || api === 0x0110;
export const isSupportedHackrfApi = (api: number): boolean => isStableHackrfApi(api) || api === 0x0113;
export const LIVE_SAMPLE_RATES_HZ = [1_024_000, 2_400_000] as const;
export const HACKRF_SAMPLE_RATES_HZ = [1_024_000, 2_400_000, 4_800_000, 9_600_000, 19_200_000] as const;
export const BLADERF_SAMPLE_RATES_HZ = [2_400_000, 4_800_000, 9_600_000, 19_200_000] as const;
export type BladeRfSampleRateHz = typeof BLADERF_SAMPLE_RATES_HZ[number];
export type HackrfSampleRateHz = typeof HACKRF_SAMPLE_RATES_HZ[number];
export const isWidebandRate = (rate: number): boolean => rate === 4_800_000 || rate === 9_600_000 || rate === 19_200_000;
export const channelSampleRate = (nativeRate: number): number => isWidebandRate(nativeRate) ? 2_400_000 : nativeRate;
export const hackrfDecimationExponent = (rate: number): number => rate === 1_024_000 ? 5 : rate === 2_400_000 ? 4 : rate === 4_800_000 ? 3 : rate === 9_600_000 ? 2 : 1;
export const hackrfDecimationFactor = (rate: number): 2 | 4 | 8 | 16 | 32 => rate === 1_024_000 ? 32 : rate === 2_400_000 ? 16 : rate === 4_800_000 ? 8 : rate === 9_600_000 ? 4 : 2;
export type HostResampling = { kind: "none"; numerator: 1; denominator: 1 }
  | { kind: "channel-fir-decimate-2-v1"; numerator: 1; denominator: 2 }
  | { kind: "channel-fir-decimate-4-v1"; numerator: 1; denominator: 4 }
  | { kind: "channel-fir-decimate-8-v1"; numerator: 1; denominator: 8 };
export const hostResamplingForRate = (rate: number): HostResampling => rate === 19_200_000
  ? { kind: "channel-fir-decimate-8-v1", numerator: 1, denominator: 8 }
  : rate === 9_600_000
  ? { kind: "channel-fir-decimate-4-v1", numerator: 1, denominator: 4 }
  : rate === 4_800_000
  ? { kind: "channel-fir-decimate-2-v1", numerator: 1, denominator: 2 }
  : { kind: "none", numerator: 1, denominator: 1 };
export type HackrfLnaGainCode = 0 | 16 | 33;

export interface HackrfRxSettings {
  kind: "hackrf";
  rxLnaGainCode: HackrfLnaGainCode;
  rxVgaGainDb: number;
  rfAmplifierEnabled: boolean;
  antennaPowerEnabled: false;
}
export const DEFAULT_HACKRF_RX_SETTINGS: Readonly<HackrfRxSettings> = Object.freeze({
  kind: "hackrf", rxLnaGainCode: 16, rxVgaGainDb: 12,
  rfAmplifierEnabled: false, antennaPowerEnabled: false,
});

export interface HackrfIdentity {
  kind: "hackrf-pro";
  vendorId: number;
  productId: number;
  boardId: number;
  boardRevisionRaw: number;
  usbApiVersion: number;
  firmwareVersion: string;
  partIdWords: readonly [number, number];
  serialWords: readonly [number, number, number, number];
  platformSupport: number;
}

/** Only the adapter may supply these results after checking actual transfers. */
export interface HackrfRuntimeEvidence {
  identity: HackrfIdentity;
  descriptorLayoutVerified: boolean;
  mandatoryQueriesVerified: boolean;
  standardImageIndex: number;
  standardImageSelectionAcknowledged: boolean;
}
export interface HackrfDiscoveredCapabilities {
  source: "hackrf";
  phase: "discovered";
  protocolProfile: HackrfProtocolProfile;
  referenceCommit: HackrfReferenceCommit;
  identity: HackrfIdentity;
  nativeEncoding: "ci8";
  standardImageIndex: 0;
  formatEvidence: "standard-image-selection-acknowledged";
  /** Probes are not firmware authentication or physical validation. */
  firmwareBuildValidation: "unvalidated";
  hardwareValidation: "pending";
}

export interface HackrfCaptureSettings extends HackrfRxSettings {
  requestedCenterFrequencyHz: number;
  requestedSampleRateHz: HackrfSampleRateHz;
  appliedRateFixed36: string | null;
  appliedRfFixed24: string | null;
  appliedRotation: number | null;
  reportedBasebandBandwidthHz: number | null;
  reportedAnalogLpfTargetHz: number | null;
  settingsEvidence: "accepted-and-firmware-reported" | "usb-acknowledged";
  /** SPI readback of the stable gateware control byte; not an RF/rate readback. */
  stableFpgaControl?: number;
}

/** Optional on legacy sessions; mandatory for the forthcoming HackRF backend. */
export interface HackrfSessionDetails {
  capabilities: HackrfDiscoveredCapabilities;
  nativeEncoding: "ci8";
  nativeSampleRateHz: number;
  effectiveSampleRateHz: number;
  adcSampleRateHz: number;
  fpgaDecimationFactor: 2 | 4 | 8 | 16 | 32;
  hostResampling: HostResampling;
  rateEvidence: "firmware-reported" | "requested-and-acknowledged";
  captureSettings: HackrfCaptureSettings;
}

export interface SourceCapabilities {
  readonly source: SourceKind;
  readonly label: string;
  readonly requiresUsb: boolean;
  readonly persistentConnection: boolean;
  readonly frequency: { readonly minimumHz: number; readonly maximumHz: number; readonly integerHz: boolean; readonly limitsDiscoveredAtTune: boolean };
  readonly rates: { readonly kind: "choices"; readonly valuesHz: readonly number[]; readonly defaultHz: number; readonly experimentalHz?: readonly number[] }
    | { readonly kind: "recording"; readonly minimumHz: number; readonly maximumHz: number };
  readonly modes: readonly ReceiverMode[];
  readonly gain: { readonly kind: "rtl-auto-manual"; readonly minimumDb: number; readonly maximumDb: number }
    | { readonly kind: "hackrf-stages"; readonly lnaCodes: readonly HackrfLnaGainCode[]; readonly vgaMinimumDb: number; readonly vgaMaximumDb: number; readonly vgaStepDb: number; readonly antennaPowerEnabled: false }
    | { readonly kind: "none" };
}

const legacyFrequency = { minimumHz: Number.MIN_VALUE, maximumHz: Number.MAX_SAFE_INTEGER, integerHz: false, limitsDiscoveredAtTune: false };
const sourceDefaults: Record<SourceKind, SourceCapabilities> = {
  "rtl-sdr": {
    source: "rtl-sdr", label: "RTL-SDR", requiresUsb: true, persistentConnection: true,
    frequency: { ...legacyFrequency, limitsDiscoveredAtTune: true },
    rates: { kind: "choices", valuesHz: LIVE_SAMPLE_RATES_HZ, defaultHz: 1_024_000 }, modes: RECEIVER_MODES,
    gain: { kind: "rtl-auto-manual", minimumDb: 0, maximumDb: 49.6 },
  },
  hackrf: {
    source: "hackrf", label: "HackRF Pro", requiresUsb: true, persistentConnection: true,
    frequency: { minimumHz: 100_000, maximumHz: 6_000_000_000, integerHz: true, limitsDiscoveredAtTune: false },
    rates: { kind: "choices", valuesHz: HACKRF_SAMPLE_RATES_HZ, defaultHz: 1_024_000, experimentalHz: [19_200_000] }, modes: RECEIVER_MODES,
    gain: { kind: "hackrf-stages", lnaCodes: [0, 16, 33], vgaMinimumDb: 0, vgaMaximumDb: 62, vgaStepDb: 2, antennaPowerEnabled: false },
  },
  bladerf: {
    source: "bladerf", label: "bladeRF 2.0 Micro xA4", requiresUsb: true, persistentConnection: true,
    frequency: { minimumHz: 70_000_000, maximumHz: 6_000_000_000, integerHz: true, limitsDiscoveredAtTune: false },
    rates: { kind: "choices", valuesHz: BLADERF_SAMPLE_RATES_HZ, defaultHz: 2_400_000, experimentalHz: [19_200_000] }, modes: RECEIVER_MODES,
    // The first hardware release deliberately uses the gateware's slow-attack AGC default.
    gain: { kind: "none" },
  },
  synthetic: {
    source: "synthetic", label: "Synthetic spectrum demo", requiresUsb: false, persistentConnection: false,
    frequency: legacyFrequency,
    rates: { kind: "choices", valuesHz: [1_024_000], defaultHz: 1_024_000 },
    modes: ["WBFM", "NBFM", "AM", "USB", "LSB"], gain: { kind: "none" },
  },
  replay: {
    source: "replay", label: "I/Q replay", requiresUsb: false, persistentConnection: false,
    frequency: legacyFrequency, rates: { kind: "recording", minimumHz: 8_000, maximumHz: 19_200_000 },
    modes: RECEIVER_MODES, gain: { kind: "none" },
  },
};

export function sourceCapabilities(source: SourceKind): SourceCapabilities {
  if (!Object.hasOwn(sourceDefaults, source)) throw new Error(`Unsupported signal source: ${String(source)}`);
  return sourceDefaults[source];
}

export function validateHackrfRxSettings(settings: HackrfRxSettings): HackrfRxSettings {
  if (settings.kind !== "hackrf" || ![0, 16, 33].includes(settings.rxLnaGainCode)) throw new Error("HackRF Pro RX LNA gain code must be 0, 16 or 33.");
  if (!Number.isInteger(settings.rxVgaGainDb) || settings.rxVgaGainDb < 0 || settings.rxVgaGainDb > 62 || settings.rxVgaGainDb % 2 !== 0) throw new Error("HackRF Pro RX VGA gain must be an even integer from 0 to 62 dB.");
  if (typeof settings.rfAmplifierEnabled !== "boolean" || settings.antennaPowerEnabled !== false) throw new Error("HackRF RF amplifier must be boolean and antenna power must remain off.");
  return { ...settings };
}

export function discoverHackrfCapabilities(evidence: HackrfRuntimeEvidence): HackrfDiscoveredCapabilities {
  const id = evidence.identity;
  const revision = id.boardRevisionRaw;
  const productionRevision = [9, 10, 11, 137, 138, 139].includes(revision);
  const word = (value: number) => Number.isInteger(value) && value >= 0 && value <= 0xffff_ffff;
  if (id.kind !== "hackrf-pro" || id.vendorId !== 0x1d50 || id.productId !== 0x6089 || id.boardId !== 5
    || !productionRevision || !isSupportedHackrfApi(id.usbApiVersion)
    || !word(id.platformSupport) || (id.platformSupport & 0x10) === 0
    || !/^[\x20-\x7e]{1,31}$/.test(id.firmwareVersion)
    || id.partIdWords.length !== 2 || !id.partIdWords.every(word)
    || id.serialWords.length !== 4 || !id.serialWords.every(word)
    || evidence.descriptorLayoutVerified !== true || evidence.mandatoryQueriesVerified !== true
    || evidence.standardImageIndex !== 0 || evidence.standardImageSelectionAcknowledged !== true) {
    throw new Error(`HackRF Pro requires a supported profile (USB API 0x0109/0x0110 stable or 0x0113, production revision 9–11, verified standard image 0). Detected board ${id.boardId}, revision ${revision}, API ${id.usbApiVersion}, firmware ${id.firmwareVersion}.`);
  }
  return {
    source: "hackrf", phase: "discovered", protocolProfile: isStableHackrfApi(id.usbApiVersion) ? HACKRF_STABLE_PROFILE : HACKRF_PROTOCOL_PROFILE, referenceCommit: isStableHackrfApi(id.usbApiVersion) ? HACKRF_STABLE_REFERENCE_COMMIT : HACKRF_REFERENCE_COMMIT,
    identity: { ...id, partIdWords: [...id.partIdWords], serialWords: [...id.serialWords] },
    nativeEncoding: "ci8", standardImageIndex: 0, formatEvidence: "standard-image-selection-acknowledged",
    firmwareBuildValidation: "unvalidated", hardwareValidation: "pending",
  };
}

export function validateSourceFrequency(source: SourceKind, frequencyHz: number, bandwidthHz = 0): void {
  const { frequency, label } = sourceCapabilities(source);
  if (!Number.isFinite(frequencyHz)) throw new Error("Enter a valid channel frequency.");
  if (frequencyHz <= 0) throw new Error("Choose a channel frequency above 0 Hz; the connected tuner's limits are detected when tuning.");
  if (!Number.isSafeInteger(Math.round(frequencyHz))) throw new Error("Choose a channel frequency that can be represented safely in integer Hz.");
  if (frequency.integerHz && !Number.isSafeInteger(frequencyHz)) throw new Error(`${label} requires integer Hz.`);
  if (!Number.isFinite(bandwidthHz) || bandwidthHz < 0) throw new Error("Enter a valid channel bandwidth.");
  if (frequencyHz - bandwidthHz / 2 < frequency.minimumHz || frequencyHz + bandwidthHz / 2 > frequency.maximumHz) throw new Error(`${label} frequency and channel passband must fit ${frequency.minimumHz}–${frequency.maximumHz} Hz.`);
}

/** Validate effective rates (including fractional firmware readback), before routing samples. */
export function validateSourceRoute(source: SourceKind, settings: ReceiverModeSettings, sampleRateHz: number, channelFrequencyHz: number): void {
  const caps = sourceCapabilities(source);
  if (!caps.modes.includes(settings.mode)) throw new Error(`${settings.mode} is unavailable with ${caps.label}.`);
  if (!Number.isFinite(sampleRateHz) || sampleRateHz <= 0) throw new Error("Enter a valid sample rate.");
  validateModeSampleRate(settings.mode, source === "hackrf" || source === "bladerf" || source === "replay" ? channelSampleRate(sampleRateHz) : sampleRateHz);
  // Keep legacy analog behavior; Pro additionally requires the full guarded passband.
  if (source === "hackrf" || source === "bladerf") {
    if (source === "bladerf" && !BLADERF_SAMPLE_RATES_HZ.includes(sampleRateHz as BladeRfSampleRateHz)) throw new Error("bladeRF 2.0 Micro rate must be 2.4, 4.8, 9.6 or 19.2 MS/s.");
    if (source === "hackrf" && !HACKRF_SAMPLE_RATES_HZ.some((rate) => Math.abs(rate - sampleRateHz) <= 1)) throw new Error("HackRF Pro effective rate must match a supported nominal rate within 1 Hz.");
    validateSourceFrequency(source, channelFrequencyHz, settings.bandwidthHz);
    planChannelTune(channelFrequencyHz, channelFrequencyHz, sampleRateHz, settings.bandwidthHz);
  } else validateSourceFrequency(source, channelFrequencyHz);
}

export interface SourceConfiguration {
  source?: SourceKind;
  channelFrequencyHz: number;
  modeSettings?: ReceiverModeSettings;
  sampleRateHz?: number;
  gainDb?: number | null;
  hardwareSettings?: HackrfRxSettings;
}

export function validateSourceConfiguration(options: SourceConfiguration): void {
  const source = options.source ?? "rtl-sdr";
  const caps = sourceCapabilities(source);
  const mode = normalizeModeSettings(options.modeSettings ?? defaultModeSettings("WBFM"));
  validateSourceFrequency(source, options.channelFrequencyHz);
    if (source === "hackrf") {
    if (options.gainDb !== undefined) throw new Error("HackRF uses RX stage settings, not RTL auto/manual gainDb.");
    validateHackrfRxSettings(options.hardwareSettings ?? DEFAULT_HACKRF_RX_SETTINGS);
    } else {
    if (options.hardwareSettings !== undefined) throw new Error("HackRF RX settings require the HackRF source.");
    // Existing demo/replay callers carry the legacy scalar; it controls no hardware.
    normalizeGain(options.gainDb ?? null);
  }
  const rate = options.sampleRateHz ?? (caps.rates.kind === "choices" ? caps.rates.defaultHz : undefined);
  if (rate !== undefined) {
    if (caps.rates.kind === "recording") {
      if (!Number.isFinite(rate) || rate < caps.rates.minimumHz || rate > caps.rates.maximumHz || (rate > 3_200_000 && !isWidebandRate(rate))) throw new Error("Replay sample rate must be 8000–3200000 samples/s, or CI8 at 4800000, 9600000 or 19200000 samples/s.");
    } else if (!(source === "synthetic" ? LIVE_SAMPLE_RATES_HZ : caps.rates.valuesHz).includes(rate)) {
      throw new Error(`Choose a supported ${caps.label} sample rate (${caps.rates.valuesHz.join(" or ")} samples/s).`);
    }
    // The demo ignores the legacy UI rate preference and always generates 1.024 MS/s.
    // Replay start reads mode/rate from the validated recording, not these UI
    // preferences. ReplayBackend validates that route before routing any block.
    if (source !== "replay") validateSourceRoute(source, mode, source === "synthetic" ? 1_024_000 : rate, options.channelFrequencyHz);
  } else if (!caps.modes.includes(mode.mode)) throw new Error(`${mode.mode} is unavailable with ${caps.label}.`);
}

/** Check metadata consistency, not the hardware probes performed by the adapter. */
export function validateHackrfSessionDetails(details: HackrfSessionDetails): void {
  const { capabilities: caps, captureSettings: settings } = details;
  validateHackrfRxSettings(settings);
  validateSourceFrequency("hackrf", settings.requestedCenterFrequencyHz);
  const factor = hackrfDecimationFactor(settings.requestedSampleRateHz);
  const u64 = (value: string) => {
    if (!/^(0|[1-9][0-9]{0,19})$/.test(value) || BigInt(value) > 0xffff_ffff_ffff_ffffn) throw new Error("Invalid HackRF applied unsigned 64-bit value.");
    return BigInt(value);
  };
  const fixed = (value: string, bits: bigint) => {
    const raw = u64(value);
    const scale = 2n ** bits;
    return Number(raw / scale) + Number(raw % scale) / Number(scale);
  };
  const stable = isStableHackrfApi(caps.identity.usbApiVersion);
  if (caps.source !== "hackrf" || caps.phase !== "discovered" || caps.protocolProfile !== (stable ? HACKRF_STABLE_PROFILE : HACKRF_PROTOCOL_PROFILE)
    || caps.referenceCommit !== (stable ? HACKRF_STABLE_REFERENCE_COMMIT : HACKRF_REFERENCE_COMMIT) || caps.nativeEncoding !== "ci8"
    || caps.standardImageIndex !== 0 || caps.formatEvidence !== "standard-image-selection-acknowledged") throw new Error("Invalid HackRF discovered profile.");
  discoverHackrfCapabilities({ identity: caps.identity, descriptorLayoutVerified: true,
    mandatoryQueriesVerified: true, standardImageIndex: caps.standardImageIndex, standardImageSelectionAcknowledged: true });
  if (!HACKRF_SAMPLE_RATES_HZ.includes(settings.requestedSampleRateHz)
    || ![details.nativeSampleRateHz, details.effectiveSampleRateHz, details.adcSampleRateHz].every(Number.isFinite)
    || Math.abs(details.nativeSampleRateHz - settings.requestedSampleRateHz) > 1
    || Math.abs(details.effectiveSampleRateHz - channelSampleRate(details.nativeSampleRateHz)) > 1e-6
    || details.fpgaDecimationFactor !== factor
    || Math.abs(details.adcSampleRateHz - details.nativeSampleRateHz * factor) > 1
    || details.nativeEncoding !== "ci8" || details.rateEvidence !== (stable ? "requested-and-acknowledged" : "firmware-reported")
    || details.hostResampling.kind !== hostResamplingForRate(details.nativeSampleRateHz).kind || details.hostResampling.numerator !== 1 || details.hostResampling.denominator !== hostResamplingForRate(details.nativeSampleRateHz).denominator
    ) throw new Error("HackRF reported settings/rates do not match the standard profile.");
  if (stable) {
    if (settings.settingsEvidence !== "usb-acknowledged" || details.nativeSampleRateHz !== settings.requestedSampleRateHz
      || settings.appliedRateFixed36 !== null || settings.appliedRfFixed24 !== null || settings.appliedRotation !== null
      || settings.reportedBasebandBandwidthHz !== null || settings.reportedAnalogLpfTargetHz !== null
      || ![1, 3, 7].includes(settings.stableFpgaControl!)) throw new Error("Invalid stable HackRF acknowledgement/FPGA evidence; RF/rate readbacks are unavailable.");
  } else if (settings.settingsEvidence !== "accepted-and-firmware-reported"
    || typeof settings.appliedRateFixed36 !== "string" || typeof settings.appliedRfFixed24 !== "string"
    || Math.abs(fixed(settings.appliedRateFixed36, 36n) - details.nativeSampleRateHz) > 1e-6
    || Math.abs(fixed(settings.appliedRfFixed24, 24n) - settings.requestedCenterFrequencyHz) > 1_000
    || ![0, 0x40000000, 0xc0000000].includes(settings.appliedRotation!)
    || ![settings.reportedBasebandBandwidthHz, settings.reportedAnalogLpfTargetHz].every((value) => typeof value === "number" && Number.isFinite(value) && value > 0)
    || settings.stableFpgaControl !== undefined) throw new Error("HackRF reported settings/rates do not match the standard profile.");
}

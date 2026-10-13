/** Wire facts independently implemented from PROTOCOL.md and its pinned sources.
 * No native host/firmware implementation is copied into this module. */
import {
  validateHackrfRxSettings,
  validateSourceFrequency, HACKRF_SAMPLE_RATES_HZ,
  type HackrfIdentity, type HackrfRxSettings, type HackrfSampleRateHz, type HackrfSessionDetails,
} from "./sourceCapabilities";

export const HACKRF_USB_FILTER = Object.freeze({ vendorId: 0x1d50, productId: 0x6089 });
export const HACKRF_DEADLINE_MS = 2_000;
const UNSET = 0xffff_ffff_ffff_ffffn;
export interface HackrfConfiguration {
  generation: number;
  centerFrequencyHz: number;
  sampleRateHz: HackrfSampleRateHz;
  settings: HackrfRxSettings;
}
export interface HackrfConfiguredSession {
  generation: number;
  hardwareCenterFrequencyHz: number;
  details: HackrfSessionDetails;
}
export interface HackrfControlIo {
  input(request: number, value: number, index: number, length: number, minimumLength?: number, timeoutMs?: number): Promise<DataView>;
  output(request: number, value: number, index: number, data?: Uint8Array<ArrayBuffer>): Promise<void>;
  pause(ms: number): Promise<void>;
  now(): number;
}

export function validateHackrfConfiguration(config: HackrfConfiguration, identity?: HackrfIdentity): HackrfConfiguration {
  if (!Number.isSafeInteger(config.generation) || config.generation < 0) throw new Error("Invalid HackRF acquisition generation.");
  validateSourceFrequency("hackrf", config.centerFrequencyHz, 0, identity);
  if (!HACKRF_SAMPLE_RATES_HZ.includes(config.sampleRateHz)) throw new Error("Unsupported HackRF sample rate.");
  if (identity?.kind === "hackrf-one" && config.sampleRateHz !== 9_600_000) throw new Error("HackRF One requires 9.6 MS/s native acquisition in this experimental profile. Choose 9.6 MS/s before connecting.");
  return { ...config, settings: validateHackrfRxSettings(config.settings, identity?.kind ?? "unknown") };
}
export function hackrfFrequencyPayload(frequencyHz: number): Uint8Array<ArrayBuffer> {
  validateSourceFrequency("hackrf", frequencyHz);
  const data = new Uint8Array(8); const view = new DataView(data.buffer);
  view.setUint32(0, Math.floor(frequencyHz / 1_000_000), true);
  view.setUint32(4, frequencyHz % 1_000_000, true);
  return data;
}
export function hackrfRatePayload(rate: HackrfSampleRateHz): Uint8Array<ArrayBuffer> {
  if (!HACKRF_SAMPLE_RATES_HZ.includes(rate)) throw new Error("Unsupported HackRF sample rate.");
  const data = new Uint8Array(8); const view = new DataView(data.buffer);
  view.setUint32(0, rate, true); view.setUint32(4, 1, true); return data;
}
export function hackrfRegisterPayload(register: number, value: bigint): Uint8Array<ArrayBuffer> {
  if (!Number.isInteger(register) || register < 1 || register >= 24 || value < 0n || value > UNSET) throw new Error("Invalid writable HackRF radio register/value.");
  const data = new Uint8Array(9); data[0] = register;
  new DataView(data.buffer).setBigUint64(1, value, true); return data;
}
export function decodeHackrfFixed(value: bigint, bits: 24 | 36): number {
  if (value < 0n || value >= UNSET) throw new Error("Unset/invalid HackRF reported value.");
  const scale = 2n ** BigInt(bits);
  return Number(value / scale) + Number(value % scale) / Number(scale);
}
export function verifyHackrfDescriptor(device: USBDevice): void {
  const cfg = device.configuration;
  const iface = cfg?.interfaces.find((candidate) => candidate.interfaceNumber === 0);
  const alt = iface?.alternate;
  const input = alt?.endpoints.find((ep) => ep.direction === "in" && ep.endpointNumber === 1);
  const output = alt?.endpoints.find((ep) => ep.direction === "out" && ep.endpointNumber === 2);
  if (device.vendorId !== HACKRF_USB_FILTER.vendorId || device.productId !== HACKRF_USB_FILTER.productId
    || cfg?.configurationValue !== 1 || cfg.interfaces.length !== 1
    || !alt || alt.alternateSetting !== 0 || alt.interfaceClass !== 255 || alt.interfaceSubclass !== 255 || alt.interfaceProtocol !== 255
    || alt.endpoints.length !== 2 || output?.type !== "bulk" || output.packetSize !== 512
    || input?.type !== "bulk" || input.packetSize !== 512) throw new Error("HackRF requires configuration 1/interface 0/alternate 0 and high-speed bulk IN endpoint 1.");
}

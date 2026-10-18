import type { ReceiverSnapshot } from "../radio/receiverController";
import type { SpectrumFrame } from "../radio/types";

export { SHARE_SCHEMA, MAX_SIGNAL_LENGTH, newPeerId, validPeerId, parseSignal, type SignalDescription } from "./signalingProtocol";
export const FFT_BINS = 1024;
const HEADER = 72;
const MAGIC = 0x42534431;
export interface SharedState {
  type: "state";
  generation: number;
  running: boolean;
  source: string;
  mode: string;
  frequencyHz: number;
  centerHz: number;
  rateHz: number;
}
export function sharedState(snapshot: ReceiverSnapshot): SharedState {
  const session = snapshot.session;
  return {
    type: "state", generation: snapshot.sessionGeneration,
    running: snapshot.lifecycle === "running", source: session?.source ?? "none", mode: session?.mode ?? "OFF",
    frequencyHz: session?.selectedChannelFrequencyHz ?? 0, centerHz: session?.hardwareCenterFrequencyHz ?? 0,
    rateHz: session?.actualSampleRateHz ?? 0,
  };
}
export function parseState(text: string): SharedState | undefined {
  if (text.length > 1024) return;
  try {
    const v = JSON.parse(text) as SharedState;
    if (v?.type !== "state" || typeof v.running !== "boolean" || !Number.isSafeInteger(v.generation) || v.generation < 0 ||
      !["none", "synthetic", "rtl-sdr", "hackrf", "bladerf", "usrp-b205", "replay"].includes(v.source) ||
      typeof v.mode !== "string" || v.mode.length > 24 || ![v.frequencyHz, v.centerHz, v.rateHz].every(n => Number.isFinite(n) && n >= 0 && n <= 10e9)) return;
    return { type: "state", generation: v.generation, running: v.running, source: v.source, mode: v.mode,
      frequencyHz: v.frequencyHz, centerHz: v.centerHz, rateHz: v.rateHz };
  } catch { return; }
}
/** Peak-preserving reduction, fixed -160..+40 dB rel. quantization, little endian. */
export function encodeSpectrum(frame: SpectrumFrame): ArrayBuffer {
  const bytes = new ArrayBuffer(HEADER + FFT_BINS);
  const view = new DataView(bytes);
  view.setUint32(0, MAGIC, true);
  [frame.sessionGeneration, frame.sequence, frame.timestampMs, frame.sampleIndex, frame.centerFrequencyHz, frame.sampleRateHz,
    frame.droppedFramesBefore, frame.missingSamplesBefore ?? 0].forEach((v, i) => view.setFloat64(8 + i * 8, v, true));
  const output = new Uint8Array(bytes, HEADER);
  for (let i = 0; i < FFT_BINS; i++) {
    const start = Math.floor(i * frame.bins.length / FFT_BINS);
    const end = Math.max(start + 1, Math.floor((i + 1) * frame.bins.length / FFT_BINS));
    let peak = -160;
    for (let j = start; j < end; j++) if (Number.isFinite(frame.bins[j])) peak = Math.max(peak, frame.bins[j]!);
    output[i] = Math.round(Math.max(0, Math.min(255, (peak + 160) * 255 / 200)));
  }
  return bytes;
}
export function decodeSpectrum(bytes: unknown): SpectrumFrame | undefined {
  if (!(bytes instanceof ArrayBuffer) || bytes.byteLength !== HEADER + FFT_BINS) return;
  const view = new DataView(bytes);
  if (view.getUint32(0, true) !== MAGIC) return;
  const [generation, sequence, timestamp, sampleIndex, center, rate, drops, missing] = Array.from({ length: 8 }, (_, i) => view.getFloat64(8 + i * 8, true)) as [number, number, number, number, number, number, number, number];
  if (![generation, sequence, sampleIndex, drops, missing].every(n => Number.isSafeInteger(n) && n >= 0) ||
    !Number.isFinite(timestamp) || timestamp < 0 || !Number.isFinite(center) || center < 0 || center > 10e9 || !Number.isFinite(rate) || rate <= 0 || rate > 100e6) return;
  return { sessionGeneration: generation, sequence, timestampMs: timestamp, sampleIndex, centerFrequencyHz: center, sampleRateHz: rate,
    units: "relative-dB", droppedFramesBefore: drops, missingSamplesBefore: missing, bins: Float32Array.from(new Uint8Array(bytes, HEADER), v => v * 200 / 255 - 160) };
}
export function stereoDescription(description: RTCSessionDescriptionInit): RTCSessionDescriptionInit {
  const sdp = description.sdp?.replace(/a=fmtp:(\d+) ([^\r\n]*)/g, (line, payload: string, parameters: string) => {
    if (!description.sdp?.includes(`a=rtpmap:${payload} opus/48000`)) return line;
    const clean = parameters.split(";").filter(p => !/^(stereo|sprop-stereo|maxaveragebitrate|usedtx)=/.test(p.trim()));
    return `a=fmtp:${payload} ${clean.join(";")};stereo=1;sprop-stereo=1;maxaveragebitrate=128000;usedtx=0`;
  });
  return { type: description.type, sdp };
}

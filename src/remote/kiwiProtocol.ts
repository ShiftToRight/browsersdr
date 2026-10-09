import {
  receiverUrl,
  REMOTE_CW_TONE_HZ,
  type RemoteTune,
} from "./openWebRxProtocol";

export const KIWI_MODES = ["am", "usb", "lsb", "cw", "nfm"] as const;
export const KIWI_BINS = 1024;
export const KIWI_COUNTER = KIWI_BINS * 2 ** 14;
export function kiwiUrls(input: string, id: number, pageProtocol?: string) {
  const { website } = receiverUrl(input, pageProtocol);
  const base = new URL(website);
  base.protocol = base.protocol === "https:" ? "wss:" : "ws:";
  return {
    website,
    sound: new URL(`ws/kiwi/${id}/SND`, base).href,
    waterfall: new URL(`ws/kiwi/${id}/W/F`, base).href,
  };
}
export function kiwiTune(
  tune: RemoteTune,
  bandwidth: number,
  offset: number,
  rate: number,
) {
  const { frequency, mode, lowCut, highCut } = tune;
  const carrier = frequency - offset - (mode === "cw" ? REMOTE_CW_TONE_HZ : 0);
  if (
    !KIWI_MODES.some((m) => m === mode) ||
    ![frequency, lowCut, highCut, carrier, rate].every(Number.isFinite) ||
    frequency < 0 ||
    lowCut >= highCut ||
    Math.max(Math.abs(lowCut), Math.abs(highCut)) > rate / 2 ||
    carrier + lowCut < 0 ||
    carrier + highCut > bandwidth
  )
    throw new Error(
      "The channel and filter must fit within this KiwiSDR's band and audio passband.",
    );
  return `SET mod=${mode === "nfm" ? "nbfm" : mode} low_cut=${Math.round(lowCut)} high_cut=${Math.round(highCut)} freq=${(carrier / 1000).toFixed(3)}`;
}
export function kiwiWindow(
  frequency: number,
  zoom: number,
  bandwidth: number,
  offset: number,
) {
  const span = bandwidth / 2 ** zoom;
  const left = Math.max(
    0,
    Math.min(bandwidth - span, frequency - offset - span / 2),
  );
  const start = Math.round((left / bandwidth) * KIWI_COUNTER);
  return {
    start,
    zoom,
    span,
    center: offset + (start / KIWI_COUNTER) * bandwidth + span / 2,
  };
}
/** Binary MSG/SND/W/F tags; never interpret received mono audio as I/Q. */
export function kiwiTag(data: ArrayBuffer) {
  if (data.byteLength < 3 || data.byteLength > 1048576)
    throw new Error("Invalid KiwiSDR frame length.");
  return String.fromCharCode(...new Uint8Array(data, 0, 3));
}
export function kiwiAudio(data: ArrayBuffer) {
  if (
    kiwiTag(data) !== "SND" ||
    data.byteLength < 10 ||
    (data.byteLength - 10) % 2
  )
    throw new Error("Invalid KiwiSDR audio frame.");
  const view = new DataView(data),
    flags = view.getUint8(3);
  if (flags & 0x18)
    throw new Error(
      "This KiwiSDR did not provide the requested uncompressed mono audio. Open its website instead.",
    );
  const samples = new Float32Array((data.byteLength - 10) / 2);
  for (let i = 0; i < samples.length; i++)
    samples[i] = view.getInt16(10 + i * 2, Boolean(flags & 0x80)) / 32768;
  return {
    samples,
    sequence: view.getUint32(4, true),
    restart: Boolean(flags & 0x24),
  };
}
export function kiwiWaterfall(
  data: ArrayBuffer,
  bandwidth: number,
  offset: number,
  maxZoom: number,
) {
  if (kiwiTag(data) !== "W/F" || data.byteLength !== 16 + KIWI_BINS)
    throw new Error("Invalid KiwiSDR waterfall frame.");
  const view = new DataView(data),
    start = view.getUint32(4, true),
    flags = view.getUint32(8, true);
  const zoom = flags & 0xffff;
  if (
    flags & 0x10000 ||
    zoom > maxZoom ||
    start > KIWI_COUNTER - KIWI_COUNTER / 2 ** zoom
  )
    throw new Error("Unsupported KiwiSDR waterfall encoding or range.");
  const span = bandwidth / 2 ** zoom;
  // The server maps relative level 0..-200 to unsigned 255..55 (one-count bias).
  const bins = Float32Array.from(
    new Uint8Array(data, 16),
    (value) => value - 255,
  );
  return {
    bins,
    start,
    zoom,
    center: offset + (start / KIWI_COUNTER) * bandwidth + span / 2,
    span,
    sequence: view.getUint32(12, true),
    noSync: Boolean(flags & 0x20000),
  };
}

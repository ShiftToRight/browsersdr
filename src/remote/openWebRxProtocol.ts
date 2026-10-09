/** OpenWebRX receiver wire adapter. Server FFT is relative power; audio is mono PCM, never RF I/Q. */
export const REMOTE_CW_TONE_HZ = 700;
export const REMOTE_MODES = {
  am: "AM",
  nfm: "NFM",
  wfm: "WFM",
  usb: "USB",
  lsb: "LSB",
  cw: "CW",
} as const;
export type RemoteMode = keyof typeof REMOTE_MODES;
export type Compression = "none" | "adpcm";
export interface RemoteConfig {
  center: number;
  rate: number;
  fftSize: number;
  audioCompression: Compression;
  fftCompression: Compression;
  startFrequency: number;
  startMode: RemoteMode;
  profile: string;
  floor: number;
  ceiling: number;
}
export interface RemoteTune {
  frequency: number;
  mode: RemoteMode;
  lowCut: number;
  highCut: number;
  squelch: number;
}
export function receiverUrl(input: string, pageProtocol = location.protocol) {
  if (input.length > 2048) throw new Error("Receiver address is too long.");
  let url: URL;
  try {
    url = new URL(input.trim());
  } catch {
    throw new Error(
      "Enter the full receiver website address, including https://.",
    );
  }
  if (
    !["https:", "http:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    throw new Error(
      "Use a receiver website address without credentials, query parameters or a fragment.",
    );
  }
  if (pageProtocol === "https:" && url.protocol !== "https:")
    throw new Error(
      "This page requires an HTTPS receiver. Open an HTTP receiver on its own website.",
    );
  url.pathname = url.pathname.replace(/\/+$/, "") + "/";
  const socket = new URL("ws/", url);
  socket.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  return { website: url.href, socket: socket.href };
}
export function object(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
export function remoteMode(value: unknown): RemoteMode | undefined {
  return typeof value === "string" && Object.hasOwn(REMOTE_MODES, value)
    ? (value as RemoteMode)
    : undefined;
}
export function text(value: unknown, limit = 160): string {
  return typeof value === "string"
    ? Array.from(value)
        .filter((c) => c.charCodeAt(0) >= 32 && c.charCodeAt(0) !== 127)
        .join("")
        .slice(0, limit)
    : "";
}
export function configFrom(value: unknown): RemoteConfig | undefined {
  const p = object(value);
  const center = Number(p.center_freq),
    rate = Number(p.samp_rate),
    fftSize = Number(p.fft_size);
  if (
    p.center_freq === undefined ||
    p.samp_rate === undefined ||
    p.fft_size === undefined
  )
    return;
  if (
    typeof p.center_freq !== "number" ||
    typeof p.samp_rate !== "number" ||
    typeof p.fft_size !== "number" ||
    !Number.isFinite(center) ||
    center < 0 ||
    center > 100e9 ||
    !Number.isFinite(rate) ||
    rate < 1000 ||
    rate > 100e6 ||
    !Number.isInteger(fftSize) ||
    fftSize < 128 ||
    fftSize > 32768 ||
    (fftSize & (fftSize - 1)) !== 0
  )
    throw new Error("Invalid receiver band or spectrum configuration.");
  if (
    !["none", "adpcm"].includes(String(p.audio_compression)) ||
    !["none", "adpcm"].includes(String(p.fft_compression))
  )
    throw new Error(
      "This receiver uses an unsupported stream encoding. Open its website instead.",
    );
  const start =
    typeof p.start_freq === "number"
      ? p.start_freq
      : center + (Number(p.start_offset_freq) || 0);
  const levels = object(p.waterfall_levels);
  const min = Number(levels.min),
    max = Number(levels.max);
  return {
    center,
    rate,
    fftSize,
    audioCompression: p.audio_compression as Compression,
    fftCompression: p.fft_compression as Compression,
    startFrequency:
      Number.isFinite(start) && Math.abs(start - center) <= rate / 2
        ? start
        : center,
    startMode: remoteMode(p.start_mod) ?? "am",
    profile: `${text(p.sdr_id)}|${text(p.profile_id)}`,
    floor: Number.isFinite(min) && min >= -300 && min < 0 ? min : -120,
    ceiling: Number.isFinite(max) && max > min && max <= 100 ? max : 0,
  };
}
export function defaultTune(
  config: RemoteConfig,
  mode = config.startMode,
): RemoteTune {
  const cuts: Record<RemoteMode, [number, number]> = {
    am: [-4500, 4500],
    nfm: [-6250, 6250],
    wfm: [-75000, 75000],
    usb: [300, 3000],
    lsb: [-3000, -300],
    cw: [REMOTE_CW_TONE_HZ - 400, REMOTE_CW_TONE_HZ + 400],
  };
  return {
    frequency: config.startFrequency,
    mode,
    lowCut: cuts[mode][0],
    highCut: cuts[mode][1],
    squelch: -150,
  };
}
export function tuneMessage(config: RemoteConfig, tune: RemoteTune) {
  const { frequency, mode, lowCut, highCut, squelch } = tune;
  if (
    !remoteMode(mode) ||
    ![frequency, lowCut, highCut, squelch].every(Number.isFinite) ||
    lowCut >= highCut ||
    Math.max(Math.abs(lowCut), Math.abs(highCut)) > 100000 ||
    squelch < -150 ||
    squelch > 0
  )
    throw new Error("Check the mode, filter edges and squelch.");
  const offset = Math.round(
    frequency - config.center - (mode === "cw" ? REMOTE_CW_TONE_HZ : 0),
  );
  if (
    frequency < 0 ||
    offset + lowCut < -config.rate / 2 ||
    offset + highCut > config.rate / 2
  )
    throw new Error(
      "The channel and its filter must fit inside the current receiver band. Select another band on the receiver website.",
    );
  return {
    type: "dspcontrol",
    params: {
      mod: mode,
      offset_freq: offset,
      low_cut: lowCut,
      high_cut: highCut,
      squelch_level: squelch,
      secondary_mod: false,
    },
  };
}
// Standard IMA step sizes. The OpenWebRX wire variant begins with step=0 and uses low nibble first.
const STEPS = [
  7, 8, 9, 10, 11, 12, 13, 14, 16, 17, 19, 21, 23, 25, 28, 31, 34, 37, 41, 45,
  50, 55, 60, 66, 73, 80, 88, 97, 107, 118, 130, 143, 157, 173, 190, 209, 230,
  253, 279, 307, 337, 371, 408, 449, 494, 544, 598, 658, 724, 796, 876, 963,
  1060, 1166, 1282, 1411, 1552, 1707, 1878, 2066, 2272, 2499, 2749, 3024, 3327,
  3660, 4026, 4428, 4871, 5358, 5894, 6484, 7132, 7845, 8630, 9493, 10442,
  11487, 12635, 13899, 15289, 16818, 18500, 20350, 22385, 24623, 27086, 29794,
  32767,
];
export class ImaDecoder {
  private index = 0;
  private predictor = 0;
  private step = 0;
  private sync = 0;
  private header: number[] = [];
  private remaining = 0;
  nibble(n: number): number {
    let difference = this.step >> 3;
    if (n & 1) difference += this.step >> 2;
    if (n & 2) difference += this.step >> 1;
    if (n & 4) difference += this.step;
    this.predictor = Math.max(
      -32768,
      Math.min(32767, this.predictor + (n & 8 ? -difference : difference)),
    );
    this.index = Math.max(
      0,
      Math.min(88, this.index + ((n & 7) < 4 ? -1 : 2 * (n & 7) - 6)),
    );
    this.step = STEPS[this.index]!;
    return this.predictor;
  }
  decode(bytes: Uint8Array, synchronized: boolean): Float32Array {
    const output = new Float32Array(bytes.length * 2);
    let count = 0;
    for (const byte of bytes) {
      if (synchronized && !this.remaining) {
        if (this.sync < 4) {
          this.sync =
            byte === [83, 89, 78, 67][this.sync]
              ? this.sync + 1
              : byte === 83
                ? 1
                : 0;
          continue;
        }
        this.header.push(byte);
        if (this.header.length === 4) {
          const view = new DataView(Uint8Array.from(this.header).buffer);
          this.index = view.getInt16(0, true);
          if (this.index < 0 || this.index > 88)
            throw new Error("Invalid compressed audio header.");
          this.predictor = view.getInt16(2, true);
          this.header = [];
          this.remaining = 1001;
        }
        continue;
      }
      output[count++] = this.nibble(byte & 15);
      output[count++] = this.nibble(byte >> 4);
      if (synchronized && --this.remaining === 0) this.sync = 0;
    }
    return output.slice(0, count);
  }
}
export function fftFrame(
  data: ArrayBuffer,
  config: RemoteConfig,
): Float32Array {
  const size = data.byteLength - 1;
  let values: Float32Array;
  if (config.fftCompression === "none") {
    if (size !== config.fftSize * 4)
      throw new Error("Unexpected spectrum frame size.");
    const view = new DataView(data, 1);
    values = new Float32Array(config.fftSize);
    for (let i = 0; i < values.length; i++)
      values[i] = view.getFloat32(i * 4, true);
  } else {
    if (size * 2 !== config.fftSize + 10)
      throw new Error("Unexpected compressed spectrum size.");
    values = new ImaDecoder().decode(new Uint8Array(data, 1), false).slice(10);
    for (let i = 0; i < values.length; i++) values[i] = values[i]! / 100;
  }
  for (const value of values)
    if (!Number.isFinite(value)) throw new Error("Invalid spectrum values.");
  return values;
}
export function audioFrame(
  data: ArrayBuffer,
  compression: Compression,
  decoder: ImaDecoder,
): Float32Array {
  if (compression === "adpcm")
    return decoder.decode(new Uint8Array(data, 1), true).map((v) => v / 32768);
  if ((data.byteLength - 1) % 2) throw new Error("Invalid PCM audio frame.");
  const view = new DataView(data, 1),
    output = new Float32Array((data.byteLength - 1) / 2);
  for (let i = 0; i < output.length; i++)
    output[i] = view.getInt16(i * 2, true) / 32768;
  return output;
}

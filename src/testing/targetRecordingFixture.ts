import { modeSCrc } from "../adsb/adsbReceiver";
import { crc16X25 } from "../ais/aisReceiver";
import { IqRecorder } from "../radio/iqRecording";
import { defaultModeSettings } from "../radio/receiverConfig";
import type { SourceSessionMetadata } from "../radio/types";

/** Generated position/category RF for UI acceptance; never off-air evidence. */
export function targetRecordingFixture(mode: "ADS-B" | "AIS") {
  const rate = mode === "ADS-B" ? 2_400_000 : 1_024_000;
  const center = mode === "ADS-B" ? 1_090_000_000 : 162_000_000;
  const I = new Float32Array(Math.ceil(rate * 1.4));
  const Q = new Float32Array(I.length);
  if (mode === "ADS-B") {
    const hex = (value: string) =>
      Uint8Array.from(value.match(/../g)!.map((byte) => parseInt(byte, 16)));
    const identification = hex("8D40621D272CC371C32CE0000000");
    const crc = modeSCrc(identification.subarray(0, 11));
    identification.set([crc >>> 16, (crc >>> 8) & 255, crc & 255], 11);
    const even = hex("8D40621D58C386435CC412692AD6");
    const odd = hex("8D40621D58C382D690C8AC2863A7");
    [identification, even, odd, even].forEach((frame, index) => {
      const ideal = new Float32Array(240);
      for (const chip of [0, 2, 7, 9]) ideal[chip] = 0.9;
      for (let bit = 0; bit < 112; bit++)
        ideal[
          16 + bit * 2 + ((frame[bit >> 3]! >> (7 - (bit & 7))) & 1 ? 0 : 1)
        ] = 0.9;
      const offset = Math.round((0.05 + index * 0.32) * rate);
      for (let n = 0; n < 290; n++)
        I[offset + n] = ideal[Math.floor(((n + 0.5) * 2_000_000) / rate)] ?? 0;
    });
  } else {
    [52, 52.01, 52.02].forEach((latitude, index) => {
      const payload = new Uint8Array(21);
      const write = (start: number, length: number, value: number) => {
        for (let bit = 0; bit < length; bit++) {
          const at = start + bit;
          payload[at >> 3] =
            (payload[at >> 3] ?? 0) |
            (((value >> (length - bit - 1)) & 1) << (7 - (at & 7)));
        }
      };
      write(0, 6, 1);
      write(8, 30, 211_234_567);
      write(50, 10, 123);
      write(61, 28, 13 * 600_000);
      write(89, 27, Math.round(latitude * 600_000));
      write(116, 12, 875);
      write(128, 9, 88);
      const crc = crc16X25(payload) ^ 0xffff;
      const frame = Uint8Array.from([...payload, crc & 255, crc >> 8]);
      const flag = [0, 1, 1, 1, 1, 1, 1, 0],
        stuffed: number[] = [];
      let ones = 0;
      for (const byte of frame)
        for (let bit = 0; bit < 8; bit++) {
          const value = (byte >> bit) & 1;
          stuffed.push(value);
          if (value) {
            if (++ones === 5) {
              stuffed.push(0);
              ones = 0;
            }
          } else ones = 0;
        }
      const bits = [
        ...Array.from({ length: 24 }, (_, n) => n & 1),
        ...flag,
        ...stuffed,
        ...flag,
        1,
        1,
        1,
      ];
      let level = 1,
        phase = 0;
      const offset = Math.round((0.05 + index * 0.4) * rate);
      for (let n = 0; n < Math.ceil((bits.length * rate) / 9600); n++) {
        if (
          n === 0 ||
          Math.floor((n * 9600) / rate) !== Math.floor(((n - 1) * 9600) / rate)
        ) {
          if (bits[Math.floor((n * 9600) / rate)] === 0) level ^= 1;
        }
        phase += (2 * Math.PI * (-25_000 + (level ? 2400 : -2400))) / rate;
        I[offset + n] = 0.45 * Math.cos(phase);
        Q[offset + n] = 0.45 * Math.sin(phase);
      }
    });
  }
  const session: SourceSessionMetadata = {
    source: "synthetic",
    sessionGeneration: 1,
    requestedSampleRateHz: rate,
    actualSampleRateHz: rate,
    hardwareCenterFrequencyHz: center,
    selectedChannelFrequencyHz: center,
    mode,
    channelBandwidthHz: defaultModeSettings(mode).bandwidthHz,
    squelch: 0,
    gainDb: null,
    sampleFormat: "planar-f32-iq-normalized",
  };
  const recorder = new IqRecorder(
    session,
    "2026-10-11T00:00:00.000Z",
    I.length * 2 + 2,
    "Generated aircraft/vessel UI fixture, not received RF.",
  );
  recorder.appendNormalized({ I, Q });
  return recorder.finish("user");
}

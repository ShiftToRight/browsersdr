import { expect, it } from "vitest";
import { decodeSpectrum, encodeSpectrum, parseSignal, parseState, sharedState, stereoDescription } from "./protocol";
import type { SpectrumFrame } from "../radio/types";
import type { ReceiverSnapshot } from "../radio/receiverController";

it("encodes peak-preserving RF bins with independent literal header offsets and bounded quantization", () => {
  const bins = new Float32Array(4096).fill(-100); bins[123] = -20;
  const frame: SpectrumFrame = { sessionGeneration: 4, sequence: 18, timestampMs: 200, sampleIndex: 10000,
    centerFrequencyHz: 100e6, sampleRateHz: 2.4e6, units: "relative-dB", bins, droppedFramesBefore: 3, missingSamplesBefore: 16384 };
  const bytes = encodeSpectrum(frame), view = new DataView(bytes);
  expect(bytes.byteLength).toBe(1096); expect(view.getUint32(0, true)).toBe(0x42534431);
  expect(view.getFloat64(8, true)).toBe(4); expect(view.getFloat64(24, true)).toBe(200);
  expect(view.getFloat64(40, true)).toBe(100e6); expect(view.getFloat64(64, true)).toBe(16384);
  const decoded = decodeSpectrum(bytes)!;
  expect(decoded.bins[30]).toBeCloseTo(-19.61, 1); expect(decoded.bins[31]).toBeCloseTo(-99.61, 1);
  expect(decoded.missingSamplesBefore).toBe(16384); expect(bins[123]).toBe(-20);
});
it("rejects malformed wire sizes, nonfinite RF coordinates and negative generations", () => {
  expect(decodeSpectrum(new ArrayBuffer(65536))).toBeUndefined();
  const bytes = new ArrayBuffer(1096), view = new DataView(bytes); view.setUint32(0, 0x42534431, true);
  view.setFloat64(48, 2.4e6, true); view.setFloat64(40, NaN, true);
  expect(decodeSpectrum(bytes)).toBeUndefined(); view.setFloat64(40, 100e6, true); view.setFloat64(8, -1, true);
  expect(decodeSpectrum(bytes)).toBeUndefined();
});
it("bounds connection exchange and rejects wrong roles and schemas before WebRTC", () => {
  const id = "ab".repeat(16), offer = { schema: "browsersdr-peer-prototype-v1", id, description: { type: "offer", sdp: "v=0\r\na=temporary-connection\r\n" }, secret: "ignored" };
  expect(parseSignal(JSON.stringify(offer), "offer")).not.toHaveProperty("secret");
  expect(() => parseSignal(JSON.stringify(offer), "answer")).toThrow("answer");
  expect(() => parseSignal("x".repeat(65537), "offer")).toThrow("too large");
  expect(() => parseSignal(JSON.stringify({ ...offer, id: "guess" }), "offer")).toThrow();
  expect(() => parseSignal("null", "offer")).toThrow();
});
it("publishes only allowlisted receiver state and negotiates stereo Opus without changing other codecs", () => {
  const state = sharedState({ sessionGeneration: 7, lifecycle: "running", session: { source: "rtl-sdr", mode: "AM", selectedChannelFrequencyHz: 10e6,
    hardwareCenterFrequencyHz: 10e6, actualSampleRateHz: 2.4e6, gainDb: 35, hackrf: { serial: "private" } } } as unknown as ReceiverSnapshot);
  expect(Object.keys(state)).toEqual(["type", "generation", "running", "source", "mode", "frequencyHz", "centerHz", "rateHz"]);
  expect(parseState(JSON.stringify(state))).toEqual(state);
  expect(parseState(JSON.stringify({ ...state, generation: -1 }))).toBeUndefined();
  const description = stereoDescription({ type: "answer", sdp: "v=0\r\na=rtpmap:111 opus/48000/2\r\na=fmtp:111 minptime=10;stereo=0\r\na=fmtp:12 unchanged=1\r\n" });
  expect(description.sdp).toContain("stereo=1;sprop-stereo=1;maxaveragebitrate=128000;usedtx=0");
  expect(description.sdp).toContain("a=fmtp:12 unchanged=1"); expect(description.sdp).not.toContain("stereo=0");
});

import wire from "../testing/fixtures/sharing-wire-v1.json";
import { parseCandidate, validateIceServers } from "./signalingProtocol";
it("matches the versioned cross-repository signaling vectors", () => {
  for (const v of wire.signals) {
    const parse = () => parseSignal(v.value, v.type === "offer" ? "offer" : "answer");
    if (v.valid) expect(parse).not.toThrow(); else expect(parse).toThrow();
  }
  for (const v of wire.candidates) {
    const parse = () => parseCandidate(v.value);
    if (v.valid) expect(parse).not.toThrow(); else expect(parse).toThrow();
  }
  for (const v of wire.ice) {
    const parse = () => validateIceServers(v.value, v.relay);
    if (v.valid) expect(parse).not.toThrow(); else expect(parse).toThrow();
  }
});

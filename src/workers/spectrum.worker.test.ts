import { afterEach, expect, it, vi } from "vitest";
import type { AnalysisWorkerInput, AnalysisWorkerOutput } from "../dsp/spectrumProtocol";
vi.mock("../dsp/spectrumBackend", async () => {
  const { SpectrumAccumulator } = await import("../dsp/spectrumMath");
  return { createAnalysisBackend: async (_preference: string, size: number, averages: number) => ({
    kernel: new SpectrumAccumulator(size, averages), name: "JavaScript reference", startupMs: 0,
  }) };
});
afterEach(() => { vi.unstubAllGlobals(); vi.resetModules(); });
it.each(["samples", "samples-ci8", "samples-sc16", "samples-usrp-sc16"] as const)("returns borrowed input ownership while running a real %s intelligence probe", async encoding => {
  const sent: AnalysisWorkerOutput[] = [];
  const scope = { onmessage: null as null | ((event: {data: AnalysisWorkerInput}) => void),
    postMessage: (message: AnalysisWorkerOutput, transfer: Transferable[]) => sent.push(structuredClone(message, { transfer })) };
  vi.stubGlobal("self", scope); await import("./spectrum.worker");
  const send = (data: AnalysisWorkerInput) => scope.onmessage!({ data });
  send({ type: "configure", sessionGeneration: 12, centerFrequencyHz: 100e6, sampleRateHz: 1_024_000, backendPreference: "javascript" });
  send({ type: "probe-start", sessionGeneration: 12, requestId: 44, minimumSampleIndex: 32768, configuration: {
    sampleRateHz: 1_024_000, centerFrequencyHz: 100e6, frequencyHz: 100.125e6, bandwidthHz: 2000, seconds: 1,
  } });
  await vi.waitFor(() => expect(sent.some(m => m.type === "probe-progress")).toBe(true));
  for (let n = 0; n < 34; n++) {
    const context = { sessionGeneration: 12, sampleIndex: n * 32768, centerFrequencyHz: 100e6, sampleRateHz: 1_024_000,
      discontinuity: false, droppedInputBlocks: 0, droppedInputSamples: 0 };
    if (encoding === "samples") send({ type: encoding, ...context, I: new Float32Array(32768).buffer, Q: new Float32Array(32768).buffer });
    else send({ type: encoding, ...context, bytes: new Uint8Array(32768 * (encoding === "samples-ci8" ? 2 : 4)).buffer });
  }
  await vi.waitFor(() => expect(sent.filter(m => m.type.endsWith("-ack"))).toHaveLength(34));
  const result = sent.find(m => m.type === "probe-result");
  if (result?.type !== "probe-result") throw new Error("Missing probe result");
  expect(result.result).toMatchObject({ firstSampleIndex: 32768, sampledSeconds: 1, status: "inconclusive" });
  expect(result.result?.suggestedMode).toBeUndefined();
  send({ type: "stop", sessionGeneration: 12 });
});
it.each([-1, 1])("processes signed CI8 tone orientation %i through the actual worker message handler", async sign => {
  const sent: AnalysisWorkerOutput[] = [];
  const scope = { onmessage: null as null | ((event: { data: AnalysisWorkerInput }) => void),
    postMessage: (message: AnalysisWorkerOutput, transfer: Transferable[]) => { sent.push(structuredClone(message, { transfer })); } };
  vi.stubGlobal("self", scope); await import("./spectrum.worker");
  scope.onmessage!({ data: { type: "configure", sessionGeneration: 1, centerFrequencyHz: 4_300_000_001, sampleRateHz: 1_024_000, backendPreference: "javascript" } });
  const bytes = new Uint8Array(32768 * 2);
  for (let n = 0; n < 32768; n++) { bytes[2 * n] = Math.round(96 * Math.cos(sign * 2 * Math.PI * 31 * n / 4096)); bytes[2 * n + 1] = Math.round(96 * Math.sin(sign * 2 * Math.PI * 31 * n / 4096)); }
  for (let n = 0; n < 2; n++) scope.onmessage!({ data: { type: "samples-ci8", sessionGeneration: 1, centerFrequencyHz: 4_300_000_001, sampleRateHz: 1_024_000,
    discontinuity: false, droppedInputBlocks: 0, droppedInputSamples: 0, bytes: bytes.slice().buffer } });
  await vi.waitFor(() => expect(sent.filter(m => m.type === "samples-ci8-ack")).toHaveLength(2));
  const frame = sent.find(m => m.type === "spectrum"); if (frame?.type !== "spectrum") throw new Error("Missing frame");
  const bins = new Float32Array(frame.bins); let peak = 0; for (let n = 1; n < bins.length; n++) if (bins[n]! > bins[peak]!) peak = n;
  expect(peak).toBe(2048 + sign * 31); expect(frame.centerFrequencyHz).toBe(4_300_000_001);
  const ack = sent.find(m => m.type === "samples-ci8-ack"); if (ack?.type !== "samples-ci8-ack") throw new Error("Missing ownership return");
  expect(new Uint8Array(ack.bytes)).toEqual(bytes);
  scope.onmessage!({ data: { type: "stop", sessionGeneration: 1 } });
});

it("processes little-endian SC16 Q11 through the actual worker message handler", async () => {
  const sent: AnalysisWorkerOutput[] = [];
  const scope = { onmessage: null as null | ((event: { data: AnalysisWorkerInput }) => void),
    postMessage: (message: AnalysisWorkerOutput, transfer: Transferable[]) => { sent.push(structuredClone(message, { transfer })); } };
  vi.stubGlobal("self", scope); await import("./spectrum.worker");
  scope.onmessage!({ data: { type: "configure", sessionGeneration: 2, centerFrequencyHz: 100_000_000, sampleRateHz: 4_800_000, backendPreference: "javascript" } });
  const bytes = new Uint8Array(32768 * 4); const view = new DataView(bytes.buffer);
  for (let n = 0; n < 32768; n++) {
    view.setInt16(n * 4, Math.round(1536 * Math.cos(2 * Math.PI * 31 * n / 4096)), true);
    view.setInt16(n * 4 + 2, Math.round(1536 * Math.sin(2 * Math.PI * 31 * n / 4096)), true);
  }
  for (let n = 0; n < 6; n++) scope.onmessage!({ data: { type: "samples-sc16", sessionGeneration: 2,
    centerFrequencyHz: 100_000_000, sampleRateHz: 4_800_000, discontinuity: false,
    droppedInputBlocks: 0, droppedInputSamples: 0, bytes: bytes.slice().buffer } });
  await vi.waitFor(() => expect(sent.filter(message => message.type === "samples-sc16-ack")).toHaveLength(6));
  const frame = sent.find(message => message.type === "spectrum"); if (frame?.type !== "spectrum") throw new Error("Missing frame");
  const bins = new Float32Array(frame.bins); let peak = 0; for (let n = 1; n < bins.length; n++) if (bins[n]! > bins[peak]!) peak = n;
  expect(peak).toBe(2048 + 31); expect(frame.sampleRateHz).toBe(4_800_000);
  const ack = sent.find(message => message.type === "samples-sc16-ack"); if (ack?.type !== "samples-sc16-ack") throw new Error("Missing SC16 ownership return");
  expect(new Uint8Array(ack.bytes).byteLength).toBe(bytes.byteLength);
});

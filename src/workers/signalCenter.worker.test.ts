import { afterEach, expect, it, vi } from "vitest";
import type {
  AnalysisWorkerInput,
  AnalysisWorkerOutput,
} from "../dsp/spectrumProtocol";
import type { SourceSessionMetadata } from "../radio/types";
vi.mock("../dsp/spectrumBackend", async () => {
  const { SpectrumAccumulator } = await import("../dsp/spectrumMath");
  return {
    createAnalysisBackend: async () => ({
      kernel: new SpectrumAccumulator(),
      name: "JavaScript reference",
      startupMs: 0,
    }),
  };
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
});
const metadata: SourceSessionMetadata = {
  source: "replay",
  sessionGeneration: 1,
  requestedSampleRateHz: 1_024_000,
  actualSampleRateHz: 1_024_000,
  hardwareCenterFrequencyHz: 100_000_000,
  selectedChannelFrequencyHz: 100_125_000,
  mode: "AM",
  channelBandwidthHz: 12_500,
  squelch: 0,
  gainDb: null,
  sampleFormat: "planar-f32-iq-normalized",
};
async function setup() {
  const sent: AnalysisWorkerOutput[] = [];
  const scope = {
    onmessage: null as null | ((event: { data: AnalysisWorkerInput }) => void),
    postMessage: (message: AnalysisWorkerOutput, transfer: Transferable[]) =>
      sent.push(structuredClone(message, { transfer })),
  };
  vi.stubGlobal("self", scope);
  await import("./spectrum.worker");
  const send = (data: AnalysisWorkerInput) => scope.onmessage!({ data });
  send({
    type: "configure",
    sessionGeneration: 1,
    centerFrequencyHz: metadata.hardwareCenterFrequencyHz,
    sampleRateHz: metadata.actualSampleRateHz,
    backendPreference: "javascript",
  });
  return { sent, send };
}
function samples(
  start: number,
  offset: number,
  format: "samples" | "samples-ci8" | "samples-sc16" | "samples-usrp-sc16",
): AnalysisWorkerInput {
  const length = 32768,
    I = new Float32Array(length),
    Q = new Float32Array(length);
  const bytes = new Uint8Array(length * (format === "samples-ci8" ? 2 : 4));
  const view = new DataView(bytes.buffer);
  for (let n = 0; n < length; n++) {
    const angle =
      (2 * Math.PI * (125_000 + offset) * (start + n)) /
      metadata.actualSampleRateHz;
    I[n] = 0.7 * Math.cos(angle);
    Q[n] = 0.7 * Math.sin(angle);
    if (format === "samples-ci8") {
      bytes[2 * n] = Math.round(I[n]! * 128);
      bytes[2 * n + 1] = Math.round(Q[n]! * 128);
    } else {
      const usrp = format === "samples-usrp-sc16",
        scale = usrp ? 32768 : 2048;
      view.setInt16(n * 4, Math.round((usrp ? Q[n]! : I[n]!) * scale), true);
      view.setInt16(
        n * 4 + 2,
        Math.round((usrp ? I[n]! : Q[n]!) * scale),
        true,
      );
    }
  }
  const base = {
    sampleIndex: start,
    sessionGeneration: 1,
    centerFrequencyHz: metadata.hardwareCenterFrequencyHz,
    sampleRateHz: metadata.actualSampleRateHz,
    discontinuity: false,
    droppedInputBlocks: 0,
    droppedInputSamples: 0,
  };
  return format === "samples"
    ? { ...base, type: format, I: I.buffer, Q: Q.buffer }
    : { ...base, type: format, bytes: bytes.buffer };
}
it.each([
  "samples",
  "samples-ci8",
  "samples-sc16",
  "samples-usrp-sc16",
] as const)(
  "centers fresh %s through the actual worker handler",
  async (format) => {
    const { sent, send } = await setup();
    send({
      type: "center-start",
      sessionGeneration: 1,
      requestId: 7,
      minimumSampleIndex: 32768 * 4,
      metadata,
    });
    for (let n = 0; n < 26; n++)
      send(samples(n * 32768, n < 4 ? -3000 : 1700, format));
    await vi.waitFor(() =>
      expect(sent.some((message) => message.type === "center-result")).toBe(
        true,
      ),
    );
    const result = sent.find((message) => message.type === "center-result");
    if (result?.type !== "center-result") throw new Error("Missing result");
    expect(result.requestId).toBe(7);
    expect(result.result.kind, result.result.message).toBe("estimate");
    expect(result.result.offsetHz).toBeCloseTo(1700, -1);
  },
);
it("cancels worker requests and clears them across generations", async () => {
  const { sent, send } = await setup();
  send({
    type: "center-start",
    sessionGeneration: 1,
    requestId: 7,
    minimumSampleIndex: 0,
    metadata,
  });
  send({ type: "center-cancel", sessionGeneration: 1, requestId: 7 });
  for (let n = 0; n < 24; n++) send(samples(n * 32768, 1700, "samples"));
  await vi.waitFor(() =>
    expect(
      sent.filter((message) => message.type === "samples-ack"),
    ).toHaveLength(24),
  );
  expect(sent.some((message) => message.type === "center-result")).toBe(false);
  send({
    type: "center-start",
    sessionGeneration: 1,
    requestId: 8,
    minimumSampleIndex: 0,
    metadata,
  });
  send({
    type: "configure",
    sessionGeneration: 2,
    centerFrequencyHz: metadata.hardwareCenterFrequencyHz,
    sampleRateHz: metadata.actualSampleRateHz,
    backendPreference: "javascript",
  });
  send(samples(0, 1700, "samples"));
  await Promise.resolve();
  expect(sent.some((message) => message.type === "center-result")).toBe(false);
});

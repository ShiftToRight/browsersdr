import { describe, expect, it, vi } from "vitest";
import type { SampleBlock } from "@jtarrio/signals/radio/sample_block.js";
import { HackrfSampleAdapter } from "./hackrfSource";
import { HackrfTransport, type NativeIqBlock } from "./hackrfTransport";
import { DEFAULT_HACKRF_RX_SETTINGS } from "./sourceCapabilities";
import { FakeHackrfUsb, usbView } from "../testing/hackrfUsbFixture";

function block(bytes: Uint8Array): NativeIqBlock {
  return { bytes, encoding: "ci8", sampleOrder: "interleaved-iq", bytesPerComplexSample: 2,
    complexSampleCount: bytes.length / 2, generation: 7, nativeSampleRateHz: 1_024_000,
    sequence: 0, firstSampleIndex: 0, receivedAtMonotonicMs: 150, discontinuityBefore: null };
}
async function session() {
  const transport = new HackrfTransport(); const usb = new FakeHackrfUsb(); await transport.open(usb);
  const result = await transport.configure({ generation: 7, centerFrequencyHz: 4_300_000_001, sampleRateHz: 1_024_000, settings: DEFAULT_HACKRF_RX_SETTINGS });
  await transport.close(); return result;
}
describe("HackRF Signals sample adapter", () => {
  it("copies native byte patterns first and decodes signed extrema from an offset view", async () => {
    const events: string[] = []; let copied: Uint8Array | undefined;
    const receiver = { setSampleRate: vi.fn(() => { events.push("rate"); }), receiveSamples: vi.fn((value: SampleBlock) => {
      events.push("samples"); expect([...value.I]).toEqual([-1, 0]); expect([...value.Q]).toEqual([-1 / 128, 127 / 128]);
      expect(value.frequency).toBe(4_300_000_001); value.I.fill(99); value.Q.fill(99);
    }) };
    const adapter = new HackrfSampleAdapter(receiver, (value) => { events.push("capture"); copied = value.bytes.slice(); });
    adapter.ready(await session());
    const view = usbView([128, 255, 0, 127], 5); const bytes = new Uint8Array(view.buffer, view.byteOffset, view.byteLength);
    adapter.receive(block(bytes));
    expect([...copied!]).toEqual([128, 255, 0, 127]); expect([...bytes]).toEqual([...copied!]);
    expect(events).toEqual(["rate", "capture", "samples"]); expect(receiver.setSampleRate).toHaveBeenCalledWith(1_024_000);
  });
  it.each([-1, 1])("keeps a %i complex tone on its correct side and exact int8/128 scale", async (sign) => {
    const count = 1024; const bin = 19; const bytes = new Uint8Array(count * 2);
    for (let n = 0; n < count; n++) {
      bytes[2 * n] = Math.round(96 * Math.cos(sign * 2 * Math.PI * bin * n / count));
      bytes[2 * n + 1] = Math.round(96 * Math.sin(sign * 2 * Math.PI * bin * n / count));
    }
    const power = (sample: SampleBlock, testBin: number) => {
      let real = 0, imag = 0;
      for (let n = 0; n < count; n++) {
        const phase = -2 * Math.PI * testBin * n / count;
        real += sample.I[n]! * Math.cos(phase) - sample.Q[n]! * Math.sin(phase);
        imag += sample.I[n]! * Math.sin(phase) + sample.Q[n]! * Math.cos(phase);
        const signed = new Int8Array(bytes.buffer);
        expect(sample.I[n]).toBe(signed[2 * n]! / 128); expect(sample.Q[n]).toBe(signed[2 * n + 1]! / 128);
      }
      return (real * real + imag * imag) / count ** 2;
    };
    const receiver = { setSampleRate: vi.fn(), receiveSamples: vi.fn((samples: SampleBlock) => {
      expect(power(samples, sign * bin)).toBeCloseTo((96 / 128) ** 2, 3);
      expect(power(samples, -sign * bin)).toBeLessThan(1e-8);
    }) };
    const adapter = new HackrfSampleAdapter(receiver); adapter.ready(await session()); adapter.receive(block(bytes));
    expect(receiver.receiveSamples).toHaveBeenCalledTimes(1);
  });
  it("drops stale generations and refuses malformed/discontinuous data", async () => {
    const receiveSamples = vi.fn(); const capture = vi.fn();
    const adapter = new HackrfSampleAdapter({ setSampleRate: vi.fn(), receiveSamples }, capture);
    const value = block(Uint8Array.of(0, 127)); adapter.receive(value); expect(capture).not.toHaveBeenCalled();
    adapter.ready(await session()); adapter.receive({ ...value, generation: 6 }); expect(receiveSamples).not.toHaveBeenCalled();
    expect(() => adapter.receive({ ...value, bytes: new Uint8Array(3) })).toThrow();
    expect(() => adapter.receive({ ...value, discontinuityBefore: { missingSamples: null, reason: "reset" } })).toThrow();
    adapter.reset(); adapter.receive(value); expect(receiveSamples).not.toHaveBeenCalled();
  });
  it("reuses one planar working block and rejects async native consumers", async () => {
    const buffers: ArrayBufferLike[] = [];
    const adapter = new HackrfSampleAdapter({ setSampleRate: vi.fn(), receiveSamples: (samples) => { buffers.push(samples.I.buffer, samples.Q.buffer); } });
    adapter.ready(await session()); adapter.receive(block(Uint8Array.of(1, 2))); adapter.receive(block(Uint8Array.of(3, 4)));
    expect(buffers[0]).toBe(buffers[2]); expect(buffers[1]).toBe(buffers[3]);
    // Deliberately violate the synchronous contract to exercise runtime defense.
    const invalidCapture = (async () => undefined) as unknown as (block: NativeIqBlock) => void;
    const asynchronous = new HackrfSampleAdapter({ setSampleRate: vi.fn(), receiveSamples: vi.fn() }, invalidCapture);
    asynchronous.ready(await session()); expect(() => asynchronous.receive(block(Uint8Array.of(0, 0)))).toThrow(/synchronously/);
  });
});

it("delivers original CI8 before conversion when the receiver accepts it, preserving capture order", async () => {
  const order: string[] = [];
  const bytes = Uint8Array.of(128, 255, 0, 127);
  const receiveSamples = vi.fn();
  const receiveCi8 = vi.fn((input: Uint8Array, frequency: number) => {
    order.push("native"); expect(input).toBe(bytes); expect(frequency).toBe(4_300_000_001); return true;
  });
  const adapter = new HackrfSampleAdapter({ setSampleRate: vi.fn(), receiveSamples, receiveCi8 }, () => { order.push("capture"); });
  adapter.ready(await session()); adapter.receive(block(bytes));
  expect(order).toEqual(["capture", "native"]); expect(receiveSamples).not.toHaveBeenCalled();
  receiveCi8.mockReturnValue(false); adapter.receive(block(bytes)); expect(receiveSamples).toHaveBeenCalledOnce();
});

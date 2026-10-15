import { expect, it, vi } from "vitest";
import { AudioFirstRdsReceiver, RdsMultiplexReceiver } from "../rds/rdsMultiplexReceiver";

it("CW monitor receives I/Q only after the decoder consumes it, while ordinary data modes remain silent", () => {
  const order: string[] = [], decoded: number[] = [];
  const analog = { setSampleRate: vi.fn(), receiveSamples: (block: { I: Float32Array }) => { order.push("audio"); block.I.fill(0); } };
  const digital = { configure: vi.fn(), setSampleRate: vi.fn(), reset: vi.fn(), receiveSamples: (block: { I: Float32Array }) => { order.push("decoder"); decoded.push(...block.I); } };
  const receiver = new AudioFirstRdsReceiver(analog, new RdsMultiplexReceiver(() => {}));
  receiver.setDigitalReceiver(digital, 1_024_000, 37000, true);
  const input = { I: Float32Array.of(.5, .25), Q: new Float32Array(2), frequency: 100e6 };
  receiver.receiveSamples(input);
  expect(order).toEqual(["decoder", "audio"]); expect(decoded).toEqual([.5, .25]); expect([...input.I]).toEqual([0, 0]);
  order.length = 0;
  receiver.setDigitalReceiver(digital, 1_024_000, 37000);
  receiver.receiveSamples({ ...input, I: Float32Array.of(.5, .25) });
  expect(order).toEqual(["decoder"]);
});

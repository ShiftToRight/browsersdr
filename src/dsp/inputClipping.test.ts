import { expect, it } from "vitest";
import { InputClippingMonitor } from "./inputClipping";

it("detects both raw CU8 endpoints without mistaking quiet/DC-offset input for clipping", () => {
  const monitor = new InputClippingMonitor();
  const I = new Float32Array(1024).fill(0.8),
    Q = new Float32Array(1024).fill(-0.5);
  monitor.observePlanar(I, Q, "rtl-sdr", 0);
  expect(monitor.getSnapshot(0)).toBeUndefined();
  I.fill(127.5 / 128);
  Q.fill(-127.5 / 128);
  monitor.observePlanar(I, Q, "rtl-sdr", 300);
  expect(monitor.getSnapshot(300)?.clippedFraction).toBe(1);
  expect(I[0]).toBe(127.5 / 128);
  expect(Q[0]).toBe(-127.5 / 128);
  I.fill(0);
  Q.fill(0);
  monitor.observePlanar(I, Q, "rtl-sdr", 600);
  expect(monitor.getSnapshot(1800)).toBeUndefined();
});

it("recognizes asymmetric CI8 endpoints and resets without mutating native bytes", () => {
  const monitor = new InputClippingMonitor();
  const data = new Uint8Array(65_536);
  for (let n = 0; n < data.length; n += 2) {
    data[n] = 127;
    data[n + 1] = 128;
  }
  const before = data.slice();
  monitor.observeCi8(data, 0);
  expect(monitor.getSnapshot(0)).toEqual({
    clippedFraction: 1,
    sampledComponents: 2048,
  });
  expect(data).toEqual(before);
  monitor.reset();
  expect(monitor.getSnapshot(0)).toBeUndefined();
  data.fill(126);
  monitor.observeCi8(data, 1);
  expect(monitor.getSnapshot(1)).toBeUndefined();
});

it("does not claim clipping for unsupported inputs or statistically tiny blocks", () => {
  const monitor = new InputClippingMonitor();
  monitor.observePlanar(
    new Float32Array(1000).fill(1),
    new Float32Array(1000).fill(-1),
    "synthetic",
    0,
  );
  expect(monitor.getSnapshot(0)).toBeUndefined();
  monitor.observeCi8(Uint8Array.of(127, 128), 0);
  expect(monitor.getSnapshot(0)).toBeUndefined();
});

import { expect, it } from "vitest";
import { RtlIngress } from "./rtlIngress";

it("accounts only admitted input, freezes at stop and resets at a new rate without inventing hardware loss", () => {
  let now = 0;
  const ingress = new RtlIngress(() => now);
  ingress.begin(3_200_000);
  for (let n = 0; n < 300; n++) { now += 50; ingress.accept(160_000, 50); ingress.delivered(2); }
  expect(ingress.snapshot().rtl).toMatchObject({ deliveredSamples: 48_000_000, deliveredBytes: 96_000_000, deliveredBlocks: 300, sampleSeconds: 15, elapsedSeconds: 15, averageBytesPerSecond: 6_400_000 });
  expect(ingress.snapshot().stages["RTL delivery"]?.count).toBe(256);
  ingress.end(); now += 60_000;
  expect(ingress.snapshot().rtl?.elapsedSeconds).toBe(15);
  ingress.begin(2_400_000);
  expect(ingress.snapshot().rtl?.deliveredSamples).toBe(0);
  expect(ingress.snapshot().stages).toEqual({});
  expect(ingress.snapshot().rtl).not.toHaveProperty("lostSamples");
});

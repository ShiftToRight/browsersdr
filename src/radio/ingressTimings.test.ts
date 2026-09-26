import { expect, it } from "vitest";
import { IngressTimings } from "./ingressTimings";
it("bounds distributions, retains a run peak and resets only explicitly", () => {
  const timings = new IngressTimings(["copy"]);
  timings.record("copy", 50);
  for (let n = 0; n < 300; n++) timings.record("copy", n < 44 ? 10 : 1);
  timings.record("copy", NaN); timings.record("unknown", 100);
  expect(timings.snapshot()).toEqual({ copy: { count: 256, meanMs: 1, p99Ms: 1, maxMs: 1, lifetimeMaxMs: 50 } });
  timings.reset(); expect(timings.snapshot()).toEqual({});
});

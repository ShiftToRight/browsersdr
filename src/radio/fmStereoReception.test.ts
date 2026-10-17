import { expect, it } from "vitest";
import { FmStereoReceptionTracker } from "./fmStereoReception";

function feed(
  tracker: FmStereoReceptionTracker,
  locked: boolean,
  seconds: number,
  rate = 2_400_000,
  sizes = [32768, 137, 4095, 1],
) {
  let remaining = Math.round(seconds * rate),
    block = 0;
  let state;
  while (remaining > 0) {
    const count = Math.min(remaining, sizes[block++ % sizes.length]!);
    state = tracker.receive(locked, count / rate);
    remaining -= count;
  }
  return state;
}

it.each([336_000, 1_024_000, 2_400_000])(
  "acquires stable reception using sample time at %i, regardless of blocks",
  (rate) => {
    const tracker = new FmStereoReceptionTracker();
    expect(feed(tracker, true, 0.99, rate)).toBeUndefined();
    expect(feed(tracker, true, 0.01, rate)).toBe("stereo");
    tracker.reset();
    expect(feed(tracker, false, 1.99, rate)).toBeUndefined();
    expect(feed(tracker, false, 0.01, rate)).toBe("mono");
  },
);

it("holds stereo through short losses, detects sustained loss, and recovers", () => {
  const tracker = new FmStereoReceptionTracker();
  expect(feed(tracker, true, 2)).toBe("stereo");
  expect(feed(tracker, false, 0.2)).toBe("stereo");
  expect(feed(tracker, true, 2)).toBe("stereo");
  expect(feed(tracker, false, 2)).toBe("stereo");
  expect(feed(tracker, false, 1)).toBe("mono");
  expect(feed(tracker, true, 0.5)).toBe("mono");
  expect(feed(tracker, true, 1.5)).toBe("stereo");
});

it("settles rapid alternating lock into one persistent intermittent indication", () => {
  const tracker = new FmStereoReceptionTracker();
  const emitted: (string | undefined)[] = [];
  for (let n = 0; n < 600; n++) {
    const status = feed(tracker, n % 2 === 0, 0.01);
    if (status !== emitted.at(-1)) emitted.push(status);
  }
  expect(emitted).toEqual(["intermittent"]);
  expect(feed(tracker, true, 2)).toBe("stereo");
  for (let n = 0; n < 600; n++) feed(tracker, n % 2 === 0, 0.01);
  expect(tracker.receive(true, 0)).toBe("intermittent");
  expect(feed(tracker, false, 3)).toBe("mono");
});

it("classifies duration rather than giving tiny USB blocks equal voting weight", () => {
  const tracker = new FmStereoReceptionTracker();
  // Ten long unlocked blocks dominate one thousand tiny locked blocks.
  for (let second = 0; second < 4; second++) {
    for (let n = 0; n < 10; n++) {
      tracker.receive(false, 0.099);
      for (let k = 0; k < 100; k++) tracker.receive(true, 0.00001);
    }
  }
  expect(tracker.receive(false, 0)).toBe("mono");
});

it("clears the window and pending candidate on reset", () => {
  const tracker = new FmStereoReceptionTracker();
  feed(tracker, true, 2);
  tracker.reset();
  expect(tracker.receive(true, 0)).toBeUndefined();
  expect(feed(tracker, false, 1.99)).toBeUndefined();
  tracker.reset();
  expect(feed(tracker, true, 0.99)).toBeUndefined();
  expect(feed(tracker, true, 0.01)).toBe("stereo");
});

it("does not retain a stale stereo label when weak lock crosses the mono threshold repeatedly", () => {
  const tracker = new FmStereoReceptionTracker();
  feed(tracker, true, 2);
  const statuses: string[] = [];
  for (let n = 0; n < 10; n++) {
    const on = n % 2 ? 0.15 : 0.05;
    feed(tracker, true, on);
    const status = feed(tracker, false, 1 - on)!;
    if (statuses.at(-1) !== status) statuses.push(status);
  }
  expect(statuses).toEqual(["stereo", "intermittent"]);
});

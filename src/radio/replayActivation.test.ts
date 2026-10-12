import { expect, it, vi } from "vitest";
import { ReplayActivation, readReplayMetadata } from "./replayActivation";
import type { ReceiverSnapshot } from "./receiverController";

function setup() {
  let finish!: () => void;
  const snapshot: ReceiverSnapshot = {
    lifecycle: "connected",
    message: "",
    sessionGeneration: 1,
  };
  const controller = {
    getSnapshot: () => snapshot,
    disconnect: vi.fn(() => {
      snapshot.lifecycle = "disconnecting";
      snapshot.sessionGeneration++;
      return new Promise<void>((resolve) => {
        finish = () => {
          snapshot.lifecycle = "idle";
          resolve();
        };
      });
    }),
  };
  return { controller, snapshot, finish: () => finish() };
}
it("commits only after its own disconnect finishes", async () => {
  const run = setup();
  const activation = new ReplayActivation();
  const pending = activation.activate(run.controller, () => {});
  run.finish();
  expect(await pending).toBe(true);
});
it.each(["cancel", "abort", "generation", "cleanup"])(
  "rejects %s while asynchronous disconnect is pending",
  async (cause) => {
    const run = setup();
    const activation = new ReplayActivation();
    const aborter = new AbortController();
    const pending = activation.activate(
      run.controller,
      () => {},
      aborter.signal,
    );
    if (cause === "cancel") activation.cancel();
    if (cause === "abort") aborter.abort();
    if (cause === "generation") run.snapshot.sessionGeneration++;
    if (cause === "cleanup") run.snapshot.cleanupRequired = true;
    run.finish();
    expect(await pending).toBe(false);
  },
);

it("cancels a stalled metadata read immediately and ignores late completion", async () => {
  let finish!: (text: string) => void;
  const aborter = new AbortController();
  const pending = readReplayMetadata(
    {
      text: () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    },
    aborter.signal,
  );
  aborter.abort();
  await expect(pending).rejects.toThrow("cancelled");
  finish("late");
});

it("commits atomically so a later queued source change wins", async () => {
  const run = setup();
  const activation = new ReplayActivation();
  let selected = "replay";
  const pending = activation.activate(run.controller, () => {
    selected = "replay";
  });
  run.finish();
  queueMicrotask(() => {
    activation.cancel();
    selected = "synthetic";
  });
  await pending;
  expect(selected).toBe("synthetic");
});

import type { ReceiverController } from "./receiverController";

/** Transaction boundary shared by file imports, library replay and generated examples. */
export class ReplayActivation {
  private revision = 0;
  cancel(): void {
    this.revision++;
  }
  async activate(
    controller: Pick<ReceiverController, "disconnect" | "getSnapshot">,
    commit: () => void,
    signal?: AbortSignal,
  ): Promise<boolean> {
    const revision = ++this.revision;
    if (signal?.aborted) return false;
    const disconnect = controller.disconnect();
    // disconnect publishes its own generation synchronously, before backend cleanup.
    const generation = controller.getSnapshot().sessionGeneration;
    await disconnect;
    const current = controller.getSnapshot();
    if (
      revision !== this.revision ||
      signal?.aborted ||
      current.sessionGeneration !== generation ||
      current.lifecycle !== "idle" ||
      current.cleanupRequired
    )
      return false;
    // No promise boundary between the final guard and the owner committing settings.
    commit();
    return true;
  }
}

/** Blob reads cannot be stopped, but their stale completion must not retain the import latch. */
export function readReplayMetadata(
  file: Pick<Blob, "text">,
  signal: AbortSignal,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const finish = (error?: unknown, text?: string) => {
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
      if (error) reject(error);
      else resolve(text!);
    };
    const abort = () =>
      finish(new DOMException("Replay import cancelled.", "AbortError"));
    const timer = setTimeout(
      () => finish(new Error("Reading replay metadata timed out.")),
      30_000,
    );
    if (signal.aborted) {
      abort();
      return;
    }
    signal.addEventListener("abort", abort, { once: true });
    void file.text().then(
      (text) => finish(undefined, text),
      (error) => finish(error),
    );
  });
}

import { boundedRs41Snapshot } from "../radio/packetSnapshots";
import type { DigitalWorkerInput, DigitalWorkerOutput } from "../digital";
import { Rs41Receiver } from "../rs41/rs41Receiver";
import type { Rs41Configuration } from "../rs41/settings";
import type { Rs41Event, Rs41Snapshot } from "../rs41/types";

const receiver = new Rs41Receiver();
let generation = -1;
let lastSnapshotSequence = -1;

function send(
  message: DigitalWorkerOutput<Rs41Snapshot, Rs41Event>,
  transfer: Transferable[] = [],
): void {
  self.postMessage(message, { transfer });
}

self.onmessage = (
  event: MessageEvent<DigitalWorkerInput<Rs41Configuration>>,
) => {
  const message = event.data;
  try {
    if (message.type === "configure") {
      receiver.configure(message.configuration);
      generation = message.configuration.generation;
      lastSnapshotSequence = -1;
      send({ type: "ready", generation });
      publish();
      return;
    }
    if (message.type === "dispose") {
      receiver.dispose();
      self.close();
      return;
    }
    if (message.generation !== generation) return;
    if (message.type === "flush") {
      receiver.flush();
      publish();
      send({ type: "flushed", generation, sequence: message.sequence });
      return;
    }
    if (message.type === "reset") receiver.reset(message.discontinuity);
    else {
      receiver.receive({
        I: message.I,
        Q: message.Q,
        generation,
        firstSampleIndex: message.firstSampleIndex,
        ...(message.discontinuityBefore
          ? { discontinuityBefore: message.discontinuityBefore }
          : {}),
      });
    }
    publish();
  } catch (error) {
    send({
      type: "error",
      generation,
      message: error instanceof Error ? error.message : "RS41 worker failed.",
    });
  } finally {
    if (message.type === "samples")
      send(
        {
          type: "consumed",
          generation: message.generation,
          sequence: message.sequence,
          I: message.I,
          Q: message.Q,
        },
        [message.I.buffer, message.Q.buffer],
      );
  }
};

function publish(): void {
  const snapshot = receiver.snapshot();
  if (snapshot.sequence !== lastSnapshotSequence) {
    lastSnapshotSequence = snapshot.sequence;
    send({
      type: "snapshot",
      generation,
      publication: { ...snapshot, value: boundedRs41Snapshot(snapshot.value) },
    });
  }
  for (const publication of receiver.drainEvents())
    send({ type: "event", generation, publication });
}

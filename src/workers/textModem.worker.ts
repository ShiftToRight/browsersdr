import type { DigitalWorkerInput, DigitalWorkerOutput } from "../digital";
import { TextModemCore } from "../textmodem/receiver";
import type { TextModemConfiguration } from "../textmodem/settings";
import type { TextModemSnapshot } from "../textmodem/types";
import type { ImageScanEvent } from "../textmodem/imageTypes";

const receiver = new TextModemCore();
let generation = -1;
let lastSnapshotSequence = -1;

function send(
  message: DigitalWorkerOutput<TextModemSnapshot, ImageScanEvent>,
  transfer: Transferable[] = [],
): void {
  self.postMessage(message, { transfer });
}

self.onmessage = (
  event: MessageEvent<DigitalWorkerInput<TextModemConfiguration>>,
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
      message: error instanceof Error ? error.message : "Text modem worker failed.",
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
  for (const publication of receiver.drainEvents())
    send({ type: "event", generation, publication });
  const snapshot = receiver.snapshot();
  if (snapshot.sequence !== lastSnapshotSequence) {
    lastSnapshotSequence = snapshot.sequence;
    send({
      type: "snapshot",
      generation,
      publication: { ...snapshot, value: snapshot.value },
    });
  }
}

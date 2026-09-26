import type { DigitalWorkerInput, DigitalWorkerOutput } from "../digital";
import { SrdReceiver } from "../srd/srdReceiver";
import type { SrdConfiguration } from "../srd/settings";
import type { SrdEvent, SrdSnapshot } from "../srd/types";

const receiver = new SrdReceiver();
let generation = -1;
let lastSnapshotSequence = -1;

function send(message: DigitalWorkerOutput<SrdSnapshot, SrdEvent>, transfer: Transferable[] = []): void {
  self.postMessage(message, { transfer });
}

self.onmessage = (event: MessageEvent<DigitalWorkerInput<SrdConfiguration>>) => {
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
      send(
        {
          type: "consumed",
          generation,
          sequence: message.sequence,
          I: message.I,
          Q: message.Q,
        },
        [message.I.buffer, message.Q.buffer],
      );
    }
    publish();
  } catch (error) {
    send({
      type: "error",
      generation,
      message: error instanceof Error ? error.message : "SRD worker failed.",
    });
  }
};

function publish(): void {
  const snapshot = receiver.snapshot();
  if (snapshot.sequence !== lastSnapshotSequence) {
    lastSnapshotSequence = snapshot.sequence;
    send({ type: "snapshot", generation, publication: snapshot });
  }
  for (const publication of receiver.drainEvents())
    send({ type: "event", generation, publication });
}

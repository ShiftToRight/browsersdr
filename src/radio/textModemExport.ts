import { isTextMode } from "../textmodem/settings";
import type { ReceiverSnapshot } from "./receiverController";
export function textModemExport(receiver: ReceiverSnapshot) {
  const { session, textModem, textModemWorker } = receiver;
  if (
    !session ||
    !isTextMode(session.mode) ||
    !textModem ||
    textModem.mode !== session.mode ||
    textModemWorker?.generation !== session.sessionGeneration
  )
    return undefined;
  return {
    schema: "browsersdr-text-modem-v1",
    exportedAt: new Date().toISOString(),
    clock:
      "Original effective decoder I/Q sample clock; export time is not receive time. No inferred UTC or transmitter identity.",
    acquisition: {
      source: session.source,
      generation: session.sessionGeneration,
      nativeSampleRateHz: session.actualSampleRateHz,
      selectedChannelFrequencyHz: session.selectedChannelFrequencyHz,
      centerFrequencyHz: session.hardwareCenterFrequencyHz,
    },
    limits: { textCharacters: 8192, messages: 16, messageCharacters: 4096 },
    snapshot: textModem,
    worker: textModemWorker,
  };
}

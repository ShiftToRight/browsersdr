import type { ReceiverSnapshot } from "./receiverController";
export function pocsagExport(receiver: ReceiverSnapshot) {
  const { session, pocsag, pocsagWorker } = receiver;
  if (
    !session ||
    session.mode !== "POCSAG" ||
    !pocsag ||
    pocsagWorker?.generation !== session.sessionGeneration
  )
    return undefined;
  return {
    schema: "browsersdr-pocsag-v1",
    exportedAt: new Date().toISOString(),
    scope: "latest retained published messages",
    clock:
      "Original effective I/Q decoder sample clock; export time is not receive time. No inferred UTC or transmitter identity.",
    settings: session.pocsag,
    acquisition: {
      source: session.source,
      generation: session.sessionGeneration,
      nativeSampleRateHz: session.actualSampleRateHz,
      selectedChannelFrequencyHz: session.selectedChannelFrequencyHz,
      centerFrequencyHz: session.hardwareCenterFrequencyHz,
    },
    limits: { messages: 16, payloadWords: 128 },
    snapshot: pocsag,
    worker: pocsagWorker,
  };
}

export function pocsagJson(value: unknown): string {
  return JSON.stringify(
    value,
    (_key, item: unknown) =>
      item instanceof Uint8Array || item instanceof Uint32Array
        ? Array.from(item)
        : item,
    2,
  );
}

import {
  selectAuthorizedUsrpB205Device,
  UsrpB205Fx3Connection,
} from "../radio/usrpB205Fx3";
import { UsrpB205ControlLink } from "../radio/usrpB205Control";
import { createLocalUsrpB205NoOsDriver } from "../radio/usrpB205LocalNoOsDriver";
import { UsrpB205RxConfigurator } from "../radio/usrpB205RxConfig";
import type { UsrpB205SessionDetails } from "../radio/usrpB205Capabilities";
import {
  UsrpB205RxTransport,
  type UsrpB205NativeBlock,
} from "../radio/usrpB205RxTransport";
import { UsrpB205WorkerSampleQueue } from "../radio/usrpB205WorkerQueue";
import type {
  UsrpB205WorkerDiagnostics,
  UsrpB205WorkerCommandRequest,
  UsrpB205WorkerRequest,
  UsrpB205WorkerResponse,
} from "../radio/usrpB205WorkerSession";

const scope = self as unknown as {
  navigator: WorkerNavigator;
  postMessage(message: UsrpB205WorkerResponse, transfer?: Transferable[]): void;
  onmessage: ((event: MessageEvent<UsrpB205WorkerRequest>) => void) | null;
};

let connection: UsrpB205Fx3Connection | undefined;
let control: UsrpB205ControlLink | undefined;
let configurator: UsrpB205RxConfigurator | undefined;
let transport: UsrpB205RxTransport | undefined;
let details: UsrpB205SessionDetails | undefined;
let closed = false;
let fatalSent = false;
const SC16_PACKETS_PER_BATCH = 16;
const SC16_QUEUE_BLOCKS = 128;
const SC16_IN_FLIGHT_BLOCKS = 4;
const sampleQueue = new UsrpB205WorkerSampleQueue(SC16_QUEUE_BLOCKS);
let samplesInFlight = 0;
let batchPackets: ArrayBuffer[] = [];
let batchGeneration = 0;
let batchGaps: Array<{ missingSamples: number | null; reason: string }> = [];

function diagnostics(): UsrpB205WorkerDiagnostics {
  return {
    connection: connection?.diagnostics ?? null,
    configuration: configurator?.diagnostics ?? null,
    receive: transport?.diagnostics ?? null,
  };
}

function post(
  message: UsrpB205WorkerResponse,
  transfer: Transferable[] = [],
): void {
  scope.postMessage(message, transfer);
}

function fatal(error: unknown): void {
  if (closed || fatalSent) return;
  fatalSent = true;
  post({
    type: "fatal",
    message: error instanceof Error ? error.message : String(error),
    diagnostics: diagnostics(),
  });
}

function resetSampleQueue(): void {
  sampleQueue.clear();
  samplesInFlight = 0;
  batchPackets = [];
  batchGeneration = 0;
  batchGaps = [];
}

function pumpSamples(): void {
  while (
    !closed &&
    samplesInFlight < SC16_IN_FLIGHT_BLOCKS &&
    sampleQueue.length > 0
  ) {
    const block = sampleQueue.shift();
    if (!block) return;
    samplesInFlight++;
    post({ type: "usrp-sc16-packets", ...block }, block.packets);
  }
}

function flushBatch(): void {
  if (!details || batchPackets.length === 0) return;
  sampleQueue.pushLatest({
    generation: batchGeneration,
    frequency: details.configuration.acceptedCenterFrequencyHz,
    packets: batchPackets,
    ...(batchGaps.length ? { gapsBefore: batchGaps } : {}),
  });
  batchPackets = [];
  batchGaps = [];
  pumpSamples();
}

function receiveNative(block: UsrpB205NativeBlock): void {
  if (!details || block.generation !== transport?.diagnostics.generation)
    return;
  if (block.discontinuityBefore) {
    flushBatch();
    batchGaps.push({
      missingSamples: block.discontinuityBefore.missingSamples,
      reason: block.discontinuityBefore.reason,
    });
  }
  if (batchPackets.length && batchGeneration !== block.generation) {
    batchPackets = [];
    batchGaps = [];
  }
  if (
    !(block.nativePacketBytes.buffer instanceof ArrayBuffer) ||
    block.nativePacketBytes.byteOffset !== 0 ||
    block.nativePacketBytes.byteLength !==
      block.nativePacketBytes.buffer.byteLength
  )
    throw new Error(
      "USRP B205-mini transport did not provide an owned native packet.",
    );
  batchGeneration = block.generation;
  batchPackets.push(block.nativePacketBytes.buffer);
  if (batchPackets.length >= SC16_PACKETS_PER_BATCH || block.endOfBurst)
    flushBatch();
}

async function initialize(
  message: Extract<UsrpB205WorkerRequest, { type: "initialize" }>,
): Promise<void> {
  if (connection || closed)
    throw new DOMException(
      "USRP B205-mini worker already owns a session.",
      "InvalidStateError",
    );
  const usb = scope.navigator.usb;
  if (!usb?.getDevices)
    throw new Error(
      "Worker WebUSB getDevices() is unavailable in this Chrome build.",
    );
  let device: USBDevice | undefined;
  let candidateCount = 0;
  for (let attempt = 0; attempt < 60; attempt += 1) {
    const devices = await usb.getDevices();
    candidateCount = devices.filter(
      (candidate) =>
        candidate.vendorId === 0x2500 && candidate.productId === 0x0022,
    ).length;
    device = selectAuthorizedUsrpB205Device(devices, message.serialNumber);
    if (device) break;
    if (candidateCount > 1)
      throw new Error(
        "Multiple authorized B205-mini devices are present and the replugged identity is ambiguous.",
      );
    if (attempt < 59)
      await new Promise<void>((resolve) => setTimeout(resolve, 50));
  }
  if (!device)
    throw new Error(
      `Expected one authorized B205-mini 2500:0022 device after replug discovery; found ${candidateCount}.`,
    );

  connection = new UsrpB205Fx3Connection();
  const identity = await connection.open(
    device,
    message.image,
    message.firmware,
    usb,
  );
  const io = connection.claimedBulkIo();
  control = new UsrpB205ControlLink(io, { onFatal: fatal });
  configurator = new UsrpB205RxConfigurator(
    identity,
    control,
    createLocalUsrpB205NoOsDriver(),
    { closeOwner: () => connection!.close() },
  );
  details = await configurator.initialize(message.requested);
  transport = new UsrpB205RxTransport(
    io,
    configurator,
    details,
    {
      error: fatal,
      // Discontinuities travel with the first affected sample batch so main
      // applies them after all earlier in-flight batches, not ahead of data.
      discontinuity: () => undefined,
      generationChanged: (generation, reason, next) => {
        resetSampleQueue();
        details = structuredClone(next);
        post({ type: "generation", generation, reason, details: next });
      },
    },
    { closeOwner: () => connection!.close() },
  );
}

async function close(): Promise<void> {
  if (closed) return;
  // Suppress transfer-failure notifications caused by this intentional
  // shutdown while still keeping the control link alive for transport.stop().
  closed = true;
  resetSampleQueue();
  // A running transport must issue its stop command over the control link
  // before that link is closed. Closing control first makes Disconnect while
  // receiving fail with "control link is not running" and require a second
  // cleanup attempt.
  if (transport) {
    try {
      await transport.close();
    } finally {
      await control?.close();
    }
  } else {
    await control?.close();
    await connection?.close();
  }
}

async function execute(message: UsrpB205WorkerCommandRequest): Promise<void> {
  try {
    if (message.type === "initialize") await initialize(message);
    else if (message.type === "start") {
      if (!transport || !details)
        throw new DOMException(
          "USRP B205-mini worker is not configured.",
          "InvalidStateError",
        );
      resetSampleQueue();
      await transport.start(message.generation, receiveNative);
    } else if (message.type === "stop") {
      resetSampleQueue();
      await transport?.stopAndDrain();
    } else if (message.type === "retune") {
      if (!transport || !configurator)
        throw new DOMException(
          "USRP B205-mini worker is not configured.",
          "InvalidStateError",
        );
      details = await configurator.retune(message.centerFrequencyHz, transport);
    } else await close();
    post({
      type: "response",
      id: message.id,
      ...(details ? { details: structuredClone(details) } : {}),
      diagnostics: diagnostics(),
    });
  } catch (error) {
    post({
      type: "response-error",
      id: message.id,
      message: error instanceof Error ? error.message : String(error),
      diagnostics: diagnostics(),
    });
  }
}

let command = Promise.resolve();
scope.onmessage = (event) => {
  const message = event.data;
  if (message.type === "sample-consumed") {
    if (message.generation === transport?.diagnostics.generation) {
      samplesInFlight = Math.max(0, samplesInFlight - 1);
      pumpSamples();
    }
    return;
  }
  command = command.then(() => execute(message));
};

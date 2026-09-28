import { describe, expect, it, vi } from "vitest";
import { USRP_B205_IMAGE } from "./usrpB205Images";
import { createUsrpB205RequestedConfiguration } from "./usrpB205Capabilities";
import {
  UsrpB205WorkerSession,
  type UsrpB205WorkerRequest,
  type UsrpB205WorkerResponse,
} from "./usrpB205WorkerSession";
import { usrpB205SessionDetails } from "../testing/usrpB205SessionFixture";
import { usrpB205FirmwareFixture } from "../testing/usrpB205FirmwareFixture";

class FakeWorker {
  onmessage: ((event: MessageEvent<UsrpB205WorkerResponse>) => void) | null = null;
  onerror: OnErrorEventHandler = null;
  readonly sent: UsrpB205WorkerRequest[] = [];
  readonly transfers: Transferable[][] = [];
  terminated = false;
  postMessage(message: UsrpB205WorkerRequest, transfer: Transferable[] = []): void {
    this.sent.push(message); this.transfers.push(transfer);
  }
  terminate(): void { this.terminated = true; }
  emit(message: UsrpB205WorkerResponse): void {
    this.onmessage?.({ data: message } as MessageEvent<UsrpB205WorkerResponse>);
  }
}

const diagnostics = { connection: null, configuration: null, receive: null } as const;
const image = {
  contract: USRP_B205_IMAGE,
  bytes: Uint8Array.of(1, 2, 3),
  importedAs: "official-member" as const,
  archiveSha256: null,
  memberSha256: USRP_B205_IMAGE.memberSha256,
  legacyHash: USRP_B205_IMAGE.legacyHash,
};

describe("USRP B205-mini worker session proxy", () => {
  it("matches commands, transfers an owned image copy and forwards sample generations", async () => {
    const worker = new FakeWorker();
    const usrpSc16 = vi.fn();
    const generationChanged = vi.fn();
    const session = new UsrpB205WorkerSession({
      usrpSc16, generationChanged, discontinuity: vi.fn(), error: vi.fn(),
    }, () => worker as never);
    const initialization = session.initialize("FIXTURE", image, usrpB205FirmwareFixture(), createUsrpB205RequestedConfiguration(100_000_000));
    const request = worker.sent[0]!;
    expect(request).toMatchObject({ type: "initialize", serialNumber: "FIXTURE" });
    if (request.type !== "initialize") throw new Error("expected initialize");
    expect(worker.transfers[0]).toHaveLength(1);
    expect(request.type === "initialize" && request.image.bytes).not.toBe(image.bytes);
    const details = usrpB205SessionDetails();
    worker.emit({ type: "response", id: request.id, details, diagnostics });
    await expect(initialization).resolves.toEqual(details);

    const started = session.start(7);
    const start = worker.sent[1]!;
    expect(start).toMatchObject({ type: "start", generation: 7 });
    if (start.type !== "start") throw new Error("expected start");
    worker.emit({ type: "response", id: start.id, details, diagnostics });
    await started;
    const packet = new Uint8Array(20);
    packet.set([0, 192, 0, 64], 16);
    worker.emit({ type: "usrp-sc16-packets", generation: 7, frequency: 100_000_000, packets: [packet.buffer] });
    expect(usrpSc16).toHaveBeenCalledWith(Uint8Array.of(0, 192, 0, 64), 100_000_000, 7);
    expect(worker.sent.at(-1)).toEqual({ type: "sample-consumed", generation: 7 });
    worker.emit({ type: "generation", generation: 8, reason: "overflow", details });
    expect(generationChanged).toHaveBeenCalledWith(8, "overflow", details);
  });

  it("surfaces command errors and makes close idempotent", async () => {
    const worker = new FakeWorker();
    const session = new UsrpB205WorkerSession({
      usrpSc16: vi.fn(), generationChanged: vi.fn(), discontinuity: vi.fn(), error: vi.fn(),
    }, () => worker as never);
    const stopped = session.stopAndDrain();
    const stop = worker.sent[0]!;
    if (stop.type !== "stop") throw new Error("expected stop");
    worker.emit({ type: "response-error", id: stop.id, message: "stop failed", diagnostics });
    await expect(stopped).rejects.toThrow("stop failed");
    const closing = session.close();
    const close = worker.sent[1]!;
    if (close.type !== "close") throw new Error("expected close");
    worker.emit({ type: "response", id: close.id, diagnostics });
    await closing;
    await session.close();
    expect(worker.terminated).toBe(true);
    expect(worker.sent.filter((request) => request.type === "close")).toHaveLength(1);
  });
});

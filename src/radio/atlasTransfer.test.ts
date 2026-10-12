import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createDeterministicRecordingFixture } from "../testing/recordingFixture";
import { AtlasClient } from "./atlasClient";
import { AtlasConnection } from "./atlasConnection";
import { AtlasCredentialStore } from "./atlasCredentials";
import { readAtlasReceipts, type ReceiptStorage } from "./atlasRecovery";
import { AtlasTransferController, AtlasTransferFailure } from "./atlasTransfer";
import { prepareRecordingExport, type PreparedRecordingExport } from "./recordingExportFormat";
import { IncrementalSha256, sha256Hex } from "./sha256";

type Upload = {
  id: string; role: "data" | "metadata"; byteLength: number; partSize: number; expectedParts: number;
  state: "created" | "uploading" | "completing" | "complete" | "failed" | "aborted" | "expired";
  parts: Map<number, { bytes: Uint8Array; hash: string }>;
};

function response(status: number, value: unknown, headers?: HeadersInit): Response {
  return new Response(status === 204 ? null : JSON.stringify(value), { status, headers: { "Content-Type": "application/json", ...headers } });
}
function error(status: number, code: string, message = code): Response {
  return response(status, { error: { code, message, details: {}, request_id: "test-request" } });
}

class FakeAtlas {
  partSize = 32;
  maxInflight = 2;
  maxData = 1024 * 1024;
  analysisAvailable = true;
  analysisScheduleFails = false;
  rejectCreate?: { status: number; code: string };
  failPartOnce = false;
  failAllParts = false;
  failAfterParts?: number;
  acceptedParts = 0;
  loseCompletionResponses = false;
  loseRegistrationResponse = false;
  deferVerification = false;
  operatorId = "local";
  role: "operator" | "viewer" = "operator";
  registrationKeys: string[] = [];
  conflictingReceipt = false;
  holdParts = false;
  activeParts = 0;
  peakParts = 0;
  registrations = 0;
  analysisRequests = 0;
  readonly uploads = new Map<string, Upload>();
  readonly idempotency: string[] = [];
  readonly requestUrls: string[] = [];
  readonly loginBodies: string[] = [];
  private sequence = 0;
  private heldResolvers: Array<() => void> = [];

  releaseParts(): void { for (const resolve of this.heldResolvers.splice(0)) resolve(); }

  fetch = async (input: RequestInfo | URL, init: RequestInit = {}): Promise<Response> => {
    const path = new URL(String(input), "http://atlas.test").pathname;
    const method = init.method ?? "GET";
    this.requestUrls.push(String(input));
    if (path === "/api/v1/capabilities") return response(200, {
      schema_version: "1.0.0", supported_sigmf_versions: ["1.2.6"], supported_datatypes: ["cu8", "ci8", "ci16_le", "cf32_le"],
      max_data_bytes: String(this.maxData), max_metadata_bytes: "1048576", upload_part_bytes: String(this.partSize),
      max_inflight_parts: this.maxInflight, storage_configured: true,
      analysis: { schema_version: "signal-atlas-analysis-capabilities-v1", available: this.analysisAvailable,
        operations: this.analysisAvailable ? ["analyze", "identify"] : [], profiles: this.analysisAvailable ? ["offline-bounded-v1"] : [],
        supported_datatypes: this.analysisAvailable ? ["cu8", "ci16_le", "cf32_le"] : [], unavailable_reason: this.analysisAvailable ? null : "engine offline" },
    });
    if (path === "/api/v1/session" && method === "POST") { this.loginBodies.push(String(init.body)); return response(201, { operator_id: this.operatorId, expires_at: "2030-01-01T00:00:00Z", csrf_token: "c".repeat(43) }); }
    if (path === "/api/v1/session" && method === "DELETE") return response(204, null);
    if (path === "/api/v1/me") return response(200, { id: this.operatorId, display_name: "Test operator", role: this.role, token_id: null, bootstrap: false });
    if (this.rejectCreate && path === "/api/v1/uploads" && method === "POST") return error(this.rejectCreate.status, this.rejectCreate.code);
    if (path === "/api/v1/uploads" && method === "POST") {
      this.requireAuth(init);
      const key = new Headers(init.headers).get("Idempotency-Key")!; this.idempotency.push(key);
      const body = JSON.parse(String(init.body)) as { role: "data" | "metadata"; byte_length: string };
      const id = `00000000-0000-4000-8000-${String(++this.sequence).padStart(12, "0")}`;
      const byteLength = Number(body.byte_length);
      const upload: Upload = { id, role: body.role, byteLength, partSize: this.partSize, expectedParts: Math.ceil(byteLength / this.partSize), state: "created", parts: new Map() };
      this.uploads.set(id, upload); return response(201, this.uploadView(upload));
    }
    const uploadMatch = /^\/api\/v1\/uploads\/([^/]+)$/.exec(path);
    if (uploadMatch && method === "GET") return response(200, this.uploadView(this.uploads.get(uploadMatch[1]!)!));
    const partMatch = /^\/api\/v1\/uploads\/([^/]+)\/parts\/(\d+)$/.exec(path);
    if (partMatch && method === "PUT") {
      this.requireAuth(init); this.activeParts += 1; this.peakParts = Math.max(this.peakParts, this.activeParts);
      try {
        if (this.holdParts) await new Promise<void>((resolve, reject) => {
          this.heldResolvers.push(resolve);
          init.signal?.addEventListener("abort", () => reject(new DOMException("Cancelled", "AbortError")), { once: true });
        });
        if (this.failAllParts) throw new TypeError("network unavailable");
        if (this.failAfterParts !== undefined && this.acceptedParts >= this.failAfterParts) throw new TypeError("network unavailable after accepted part");
        if (this.failPartOnce) { this.failPartOnce = false; throw new TypeError("network interrupted"); }
        const upload = this.uploads.get(partMatch[1]!)!, number = Number(partMatch[2]);
        if (!["created","uploading"].includes(upload.state)) return error(409,"conflict","upload no longer accepts parts");
        const bytes = new Uint8Array(await (init.body as Blob).arrayBuffer());
        const hash = new Headers(init.headers).get("Content-SHA256")!;
        upload.parts.set(number, { bytes, hash }); upload.state = "uploading";
        this.acceptedParts += 1;
        return response(200, { upload_id: upload.id, part_number: number, byte_length: String(bytes.byteLength),
          sha256: this.conflictingReceipt ? "0".repeat(64) : hash, etag: `etag-${number}`, accepted_at: "2026-09-27T00:00:00Z" });
      } finally { this.activeParts -= 1; }
    }
    const completeMatch = /^\/api\/v1\/uploads\/([^/]+)\/complete$/.exec(path);
    if (completeMatch && method === "POST") {
      this.requireAuth(init); const upload = this.uploads.get(completeMatch[1]!)!;
      upload.state = this.deferVerification ? "completing" : "complete";
      if (this.loseCompletionResponses) throw new TypeError("completion response lost");
      return response(202, { id: "10000000-0000-4000-8000-000000000001", kind: "verify_upload", status: "complete", attempt: 1, failure_code: null, result: {} });
    }
    const abortMatch = /^\/api\/v1\/uploads\/([^/]+)\/abort$/.exec(path);
    if (abortMatch && method === "POST") { const upload = this.uploads.get(abortMatch[1]!)!; upload.state = "aborted"; return response(200, this.uploadView(upload)); }
    if (path.startsWith("/api/v1/jobs/")) return response(200,{id:path.split("/").at(-1),status:this.deferVerification ? "pending" : "complete"});
    if (path === "/api/v1/recordings" && method === "POST") {
      this.requireAuth(init); this.registrations += 1; this.registrationKeys.push(new Headers(init.headers).get("Idempotency-Key")!);
      if (this.loseRegistrationResponse) throw new TypeError("registration response lost");
      return response(202, { id: "20000000-0000-4000-8000-000000000001", state: "complete", recording_id: "30000000-0000-4000-8000-000000000001", failure_code: null });
    }
    if (path === "/api/v1/recordings/30000000-0000-4000-8000-000000000001") return response(200, { id: "30000000-0000-4000-8000-000000000001", current_revision_id: "40000000-0000-4000-8000-000000000001", import_status: "analysis_ready" });
    if (path.endsWith("/analysis-runs") && method === "POST") {
      this.analysisRequests += 1;
      if (!this.analysisAvailable || this.analysisScheduleFails) return error(503, "analysis_unavailable");
      return response(202, { id: "50000000-0000-4000-8000-000000000001", recording_id: "30000000-0000-4000-8000-000000000001", recording_revision_id: "40000000-0000-4000-8000-000000000001", status: "queued", recording_url: "/#/recordings/30000000-0000-4000-8000-000000000001", result_url: "/#/runs/50000000-0000-4000-8000-000000000001" });
    }
    throw new Error(`Unexpected request ${method} ${path}`);
  };

  private requireAuth(init: RequestInit): void {
    const headers = new Headers(init.headers);
    if (init.credentials !== "same-origin" || headers.get("X-CSRF-Token") !== "c".repeat(43)) throw new Error("missing same-origin session/CSRF");
  }
  private uploadView(upload: Upload) {
    return { id: upload.id, state: upload.state, role: upload.role, byte_length: String(upload.byteLength),
      accepted_bytes: String(Array.from(upload.parts.values()).reduce((sum, item) => sum + item.bytes.byteLength, 0)),
      part_size: String(upload.partSize), expected_parts: upload.expectedParts, expires_at: "2030-01-01T00:00:00Z", failure_code: null,
      parts: !["created","uploading"].includes(upload.state) ? [] : Array.from(upload.parts, ([part_number, item]) => ({ upload_id: upload.id, part_number, byte_length: String(item.bytes.byteLength), sha256: item.hash, etag: `etag-${part_number}`, accepted_at: "2026-09-27T00:00:00Z" })) };
  }
}

async function prepared(samples = 128): Promise<PreparedRecordingExport> {
  return prepareRecordingExport(createDeterministicRecordingFixture(samples), "sigmf");
}
function controller(pair: PreparedRecordingExport, atlas: FakeAtlas, retryAttempts = 3) {
  let ids = 0;
  return new AtlasTransferController(pair, { client: new AtlasClient({ fetch: atlas.fetch, retryAttempts, delay: async () => undefined }),
    pollDelay: async () => undefined, maxPolls: 5, idFactory: () => `pair-${++ids}` });
}
const request = { userToken: "token".repeat(8), title: "BSD-02 fixture", sourceKind: "synthetic" as const };

describe("incremental SHA-256", () => {
  it.each(["", "abc", "BrowserSDR bounded hashing"])("matches the standard vector for %j", value => {
    expect(sha256Hex(new TextEncoder().encode(value))).toBe(
      ({ "": "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855", abc: "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad", "BrowserSDR bounded hashing": "adbe3d49ba878992e076bb9ebaa3294f02455170abe390f22065b1b5fc96d1ae" } as Record<string, string>)[value],
    );
  });
  it("matches Node across block boundaries and fragmented updates", () => {
    const bytes = Uint8Array.from({ length: 1000 }, (_, index) => (index * 37 + 11) & 0xff);
    const incremental = new IncrementalSha256();
    for (let offset = 0; offset < bytes.length; offset += 17) incremental.update(bytes.subarray(offset, offset + 17));
    expect(incremental.hex()).toBe(createHash("sha256").update(bytes).digest("hex"));
  });
});

describe("bounded authenticated SigIntAtlas transfer", () => {
  it("uploads file-backed SigMF data in bounded slices", async () => {
    const pair = await prepared();
    const dataFile = pair.files.find(file => file.name.endsWith(".sigmf-data"))!;
    const expected = dataFile.contents as Uint8Array<ArrayBuffer>;
    dataFile.contents = new Blob([expected]);
    const atlas = new FakeAtlas();
    await expect(controller(pair, atlas).start(request)).resolves.toMatchObject({ recordingId: expect.any(String) });
    const upload = Array.from(atlas.uploads.values()).find(item => item.role === "data")!;
    const actual = Uint8Array.from(Array.from(upload.parts.entries())
      .sort(([left], [right]) => left - right)
      .flatMap(([, part]) => Array.from(part.bytes)));
    expect(actual).toEqual(expected);
  });

  it("saves an exact pair, schedules optional analysis, and obeys concurrency/buffer bounds", async () => {
    const atlas = new FakeAtlas(), transfer = controller(await prepared(), atlas);
    const result = await transfer.start({ ...request, analyzeAfterSave: true });
    expect(result).toMatchObject({ recordingId: "30000000-0000-4000-8000-000000000001", recordingRevisionId: "40000000-0000-4000-8000-000000000001", analysis: { status: "scheduled" } });
    expect(atlas.registrations).toBe(1); expect(atlas.analysisRequests).toBe(1);
    expect(atlas.requestUrls.every(url => !url.includes(request.userToken))).toBe(true);
    expect(atlas.loginBodies).toEqual([JSON.stringify({ operator_token: request.userToken })]);
    expect(atlas.peakParts).toBeLessThanOrEqual(2);
    expect(transfer.getSnapshot()).toMatchObject({ state: "saved", activeParts: 0, peakActiveParts: 2 });
    const metadata = (await prepared()).files.find(file => file.name.endsWith(".sigmf-meta"))!.contents as string;
    expect(transfer.getSnapshot().peakBufferedBytes).toBeLessThanOrEqual(atlas.partSize * atlas.maxInflight + new TextEncoder().encode(metadata).byteLength);
    for (const upload of atlas.uploads.values()) expect(upload.state).toBe("complete");
  });

  it("coalesces duplicate starts into one logical pair and stable idempotency operations", async () => {
    const atlas = new FakeAtlas(), transfer = controller(await prepared(), atlas);
    const first = transfer.start(request), second = transfer.start(request);
    expect(second).toBe(first);
    await expect(first).resolves.toMatchObject({ recordingId: expect.any(String) });
    expect(atlas.registrations).toBe(1);
    expect(new Set(atlas.idempotency).size).toBe(atlas.idempotency.length);
    await expect(transfer.start(request)).resolves.toEqual(await first);
  });

  it("retries a network loss mid-part without exceeding negotiated concurrency", async () => {
    const atlas = new FakeAtlas(); atlas.failPartOnce = true;
    const transfer = controller(await prepared(), atlas);
    await expect(transfer.start(request)).resolves.toMatchObject({ recordingId: expect.any(String) });
    expect(atlas.peakParts).toBeLessThanOrEqual(atlas.maxInflight);
  });

  it("reconciles a lost completion response instead of creating a false failure", async () => {
    const atlas = new FakeAtlas(); atlas.loseCompletionResponses = true;
    const transfer = controller(await prepared(), atlas, 2);
    await expect(transfer.start(request)).resolves.toMatchObject({ recordingId: expect.any(String) });
    expect(transfer.getSnapshot().state).toBe("saved");
  });

  it("rejects a conflicting receipt and never marks the pair saved", async () => {
    const atlas = new FakeAtlas(); atlas.conflictingReceipt = true;
    const transfer = controller(await prepared(), atlas);
    await expect(transfer.start(request)).rejects.toMatchObject({ code: "conflicting_bytes" });
    expect(transfer.getSnapshot()).toMatchObject({ state: "failed", errorCode: "conflicting_bytes" });
    expect(atlas.registrations).toBe(0);
  });

  it.each([
    [401, "invalid_authentication", "session_expired"],
    [403, "untrusted_origin", "untrusted_origin"],
    [429, "quota_exceeded", "quota_exceeded"],
  ] as const)("reports HTTP %s actionably without a false saved state", async (status, serverCode, expected) => {
    const atlas = new FakeAtlas(); atlas.rejectCreate = { status, code: serverCode };
    const transfer = controller(await prepared(), atlas, 1);
    await expect(transfer.start(request)).rejects.toMatchObject({ code: expected });
    expect(transfer.getSnapshot().state).toBe("failed"); expect(atlas.registrations).toBe(0);
    if (status === 403) expect(transfer.getSnapshot().message).toMatch(/same-origin proxy/);
  });

  it("rejects advertised size limits before authentication or upload", async () => {
    const atlas = new FakeAtlas(); atlas.maxData = 16;
    const transfer = controller(await prepared(), atlas);
    await expect(transfer.start(request)).rejects.toMatchObject({ code: "quota_rejected" });
    expect(atlas.uploads.size).toBe(0); expect(atlas.registrations).toBe(0);
  });

  it("keeps a saved recording when optional analysis is unavailable", async () => {
    const atlas = new FakeAtlas(); atlas.analysisAvailable = false;
    const transfer = controller(await prepared(), atlas);
    const result = await transfer.start({ ...request, analyzeAfterSave: true });
    expect(result.analysis).toEqual({ status: "unavailable", reason: "engine offline" });
    expect(transfer.getSnapshot().state).toBe("saved"); expect(atlas.analysisRequests).toBe(0);
  });

  it("keeps a saved recording when optional analysis scheduling fails", async () => {
    const atlas = new FakeAtlas(); atlas.analysisScheduleFails = true;
    const transfer = controller(await prepared(), atlas, 1);
    const result = await transfer.start({ ...request, analyzeAfterSave: true });
    expect(result.analysis).toMatchObject({ status: "failed", reason: expect.stringContaining("analysis_unavailable") });
    expect(transfer.getSnapshot()).toMatchObject({ state: "saved", recordingId: expect.any(String) });
  });

  it("does not abort or delete uploads after the recording is saved", async () => {
    const atlas = new FakeAtlas(), transfer = controller(await prepared(), atlas);
    await transfer.start(request); await transfer.cancel();
    expect(transfer.getSnapshot().state).toBe("saved");
    expect(Array.from(atlas.uploads.values()).every(upload => upload.state === "complete")).toBe(true);
  });

  it("cancels an in-flight part without publishing and prevents late responses from winning", async () => {
    const atlas = new FakeAtlas(); atlas.holdParts = true;
    const transfer = controller(await prepared(), atlas);
    const running = transfer.start(request);
    while (atlas.activeParts === 0) await new Promise(resolve => setTimeout(resolve, 0));
    await transfer.cancel(); atlas.releaseParts();
    await expect(running).rejects.toMatchObject({ code: "cancelled" });
    expect(transfer.getSnapshot().state).toBe("cancelled"); expect(atlas.registrations).toBe(0);
  });

  it("freezes generation across capture replacement and lets only the replacement save", async () => {
    const atlas = new FakeAtlas(); atlas.holdParts = true;
    const transfer = controller(await prepared(128), atlas);
    const old = transfer.start(request);
    while (atlas.activeParts === 0) await new Promise(resolve => setTimeout(resolve, 0));
    await transfer.replacePrepared(await prepared(64)); atlas.holdParts = false; atlas.releaseParts();
    await expect(old).rejects.toMatchObject({ code: "cancelled" });
    await expect(transfer.start({ ...request, title: "replacement" })).resolves.toMatchObject({ recordingId: expect.any(String) });
    expect(atlas.registrations).toBe(1);
  });

  it("revalidates bytes on retry rather than trusting filename and length", async () => {
    const atlas = new FakeAtlas(); atlas.maxInflight = 1; atlas.failAfterParts = 1;
    const pair = await prepared(), transfer = controller(pair, atlas, 1);
    await expect(transfer.start(request)).rejects.toBeInstanceOf(AtlasTransferFailure);
    const data = pair.files.find(file => file.name.endsWith(".sigmf-data"))!.contents as Uint8Array;
    data[0] = (data[0] ?? 0) ^ 0xff; atlas.failAfterParts = undefined;
    await expect(transfer.start(request)).rejects.toMatchObject({ code: "conflicting_bytes" });
    expect(atlas.registrations).toBe(0);
  });
});

describe("Atlas origin configuration", () => {
  it("rejects a secret-bearing cross-origin API configuration", () => {
    expect(() => new AtlasClient({ basePath: "https://other.example/api/v1", fetch: new FakeAtlas().fetch })).toThrow(/same browser origin/);
  });
});

it("stops hashing at the first chunk boundary after cancellation", async () => {
  const atlas = new FakeAtlas();
  atlas.partSize = 1024 * 1024; atlas.maxData = 8 * 1024 * 1024;
  let release!: () => void, started!: () => void;
  const firstRead = new Promise<void>(resolve => { started = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  let reads = 0;
  class SlowBlob extends Blob {
    override slice(start?: number, end?: number): Blob {
      const part = super.slice(start, end);
      const original = part.arrayBuffer.bind(part);
      part.arrayBuffer = async () => { reads++; started(); await gate; return original(); };
      return part;
    }
  }
  const prepared = await prepareRecordingExport(createDeterministicRecordingFixture(100), "sigmf");
  prepared.files[0].contents = new SlowBlob([new Uint8Array(4 * 1024 * 1024)]);
  const transfer = controller(prepared, atlas);
  const operation = transfer.start(request);
  const rejected = expect(operation).rejects.toMatchObject({ code: "cancelled" });
  await firstRead;
  await transfer.cancel();
  release();
  await rejected;
  expect(reads).toBe(1);
  expect(atlas.uploads.size).toBe(0);
});


describe("verification recovery after closed upload receipts disappear", () => {
  function storage(): ReceiptStorage {
    const values=new Map<string,string>();
    return {getItem:key=>values.get(key)??null,setItem:(key,value)=>{values.set(key,value);}};
  }
  it("freezes both roles, reports queued verification and retries without PUT or overcounted progress", async () => {
    const atlas=new FakeAtlas(); atlas.deferVerification=true;
    const transfer=controller(await prepared(),atlas);
    await expect(transfer.start(request)).rejects.toMatchObject({code:"reconciliation_timeout"});
    expect(transfer.getSnapshot()).toMatchObject({state:"waiting",verificationStage:"queued"});
    expect([...atlas.uploads.values()].map(upload=>upload.state)).toEqual(["completing","completing"]);
    const parts=atlas.acceptedParts;
    atlas.deferVerification=false;
    for (const upload of atlas.uploads.values()) upload.state="complete";
    await expect(transfer.start(request)).resolves.toMatchObject({recordingId:expect.any(String)});
    expect(atlas.acceptedParts).toBe(parts);
    expect(transfer.getSnapshot().bytesTransferred).toBe(transfer.getSnapshot().totalBytes);
    expect(atlas.registrations).toBe(1);
  });
  it("recovers both frozen uploads after a browser restart without files or stored credentials", async () => {
    const atlas=new FakeAtlas(); atlas.deferVerification=true; const receipts=storage();
    const first=new AtlasTransferController(await prepared(),{client:new AtlasClient({fetch:atlas.fetch}),receiptStorage:receipts,maxPolls:1,pollDelay:async()=>undefined,idFactory:()=>"original-pair"});
    await expect(first.start(request)).rejects.toMatchObject({code:"reconciliation_timeout"});
    const receipt=readAtlasReceipts(receipts)[0]!;
    expect(receipt.uploads.data).toBeTruthy();expect(receipt.uploads.metadata).toBeTruthy();
    expect(JSON.stringify(receipt)).not.toContain(request.userToken);
    const parts=atlas.acceptedParts;
    atlas.deferVerification=false;for(const upload of atlas.uploads.values())upload.state="complete";
    const restored=new AtlasTransferController(undefined,{client:new AtlasClient({fetch:atlas.fetch}),receipt,receiptStorage:receipts});
    await expect(restored.start({...request,title:"Changed title is ignored"})).resolves.toMatchObject({recordingId:expect.any(String)});
    expect(atlas.acceptedParts).toBe(parts);
    expect(atlas.registrationKeys).toEqual(["browsersdr-original-pair-recording"]);
    expect(readAtlasReceipts(receipts)[0]!.request.title).toBe(request.title);
    expect(readAtlasReceipts(receipts)[0]!.result?.recordingId).toBeTruthy();
  });
  it("refuses recovery with another account before accessing upload state", async () => {
    const atlas=new FakeAtlas();atlas.deferVerification=true;const receipts=storage();
    const first=new AtlasTransferController(await prepared(),{client:new AtlasClient({fetch:atlas.fetch}),receiptStorage:receipts,maxPolls:1,pollDelay:async()=>undefined});
    await expect(first.start(request)).rejects.toMatchObject({code:"reconciliation_timeout"});
    const receipt=readAtlasReceipts(receipts)[0]!;atlas.operatorId="other";
    const restored=new AtlasTransferController(undefined,{client:new AtlasClient({fetch:atlas.fetch}),receipt,receiptStorage:receipts});
    await expect(restored.start(request)).rejects.toMatchObject({code:"recovery_owner"});
    expect(atlas.registrations).toBe(0);
  });
  it("replays the immutable recording key after a lost registration response and restart", async () => {
    const atlas=new FakeAtlas(); atlas.loseRegistrationResponse=true; const receipts=storage();
    const client=new AtlasClient({fetch:atlas.fetch,retryAttempts:1,delay:async()=>undefined});
    const first=new AtlasTransferController(await prepared(),{client,receiptStorage:receipts,idFactory:()=>"lost-registration",pollDelay:async()=>undefined});
    await expect(first.start(request)).rejects.toBeInstanceOf(AtlasTransferFailure);
    const receipt=readAtlasReceipts(receipts)[0]!; const parts=atlas.acceptedParts;
    atlas.loseRegistrationResponse=false;
    const restored=new AtlasTransferController(undefined,{client,receipt,receiptStorage:receipts});
    await expect(restored.start(request)).resolves.toMatchObject({recordingId:expect.any(String)});
    expect(atlas.acceptedParts).toBe(parts);
    expect(atlas.registrationKeys).toEqual(["browsersdr-lost-registration-recording","browsersdr-lost-registration-recording"]);
  });

});

describe("production shared session transfer wiring", () => {
  it("reuses a settings login, retaining the original receipt owner", async () => {
    const atlas = new FakeAtlas();
    const client = new AtlasClient({ fetch: atlas.fetch, retryAttempts: 1 });
    const credentials = new AtlasCredentialStore(null);
    const connection = new AtlasConnection(credentials, client);
    credentials.save(request.userToken, false);
    try {
      await connection.testConnection();
      const transfer = new AtlasTransferController(await prepared(), { client, connection, receiptStorage: null, pollDelay: async () => undefined, maxPolls: 5 });
      await transfer.start(request);
      expect(atlas.loginBodies).toHaveLength(1);
      expect(atlas.registrations).toBe(1);
      expect(connection.getSnapshot().transferActive).toBe(false);
    } finally { connection.dispose(); credentials.dispose(); }
  });
  it("blocks a viewer before upload or recording writes", async () => {
    const atlas = new FakeAtlas(); atlas.role = "viewer";
    const client = new AtlasClient({ fetch: atlas.fetch, retryAttempts: 1 });
    const credentials = new AtlasCredentialStore(null);
    const connection = new AtlasConnection(credentials, client);
    credentials.save(request.userToken, false);
    try {
      const transfer = new AtlasTransferController(await prepared(), { client, connection, receiptStorage: null });
      await expect(transfer.start(request)).rejects.toMatchObject({ code: "role_forbidden" });
      expect(atlas.uploads.size).toBe(0);
      expect(atlas.registrations).toBe(0);
    } finally { connection.dispose(); credentials.dispose(); }
  });
  it("cannot recover a previous user's receipt through the shared connection", async () => {
    const atlas = new FakeAtlas();
    const entries = new Map<string, string>();
    const receiptStorage: ReceiptStorage = { getItem: key => entries.get(key) ?? null, setItem: (key, value) => { entries.set(key, value); } };
    const pair = await prepared();
    const owner = new AtlasTransferController(pair, { client: new AtlasClient({ fetch: atlas.fetch }), receiptStorage, pollDelay: async () => undefined, maxPolls: 5 });
    await owner.start(request);
    const receipt = readAtlasReceipts(receiptStorage)[0]!;
    atlas.operatorId = "different-user";
    const client = new AtlasClient({ fetch: atlas.fetch, retryAttempts: 1 });
    const credentials = new AtlasCredentialStore(null);
    const connection = new AtlasConnection(credentials, client);
    credentials.save(request.userToken, false);
    try {
      const recovery = new AtlasTransferController(undefined, { client, connection, receipt, receiptStorage });
      await expect(recovery.start(request)).rejects.toMatchObject({ code: "recovery_owner" });
      expect(atlas.registrations).toBe(1);
    } finally { connection.dispose(); credentials.dispose(); }
  });
});

import { AtlasClient, AtlasRequestError, type AtlasAnalysisRun, type AtlasCapabilities, type AtlasUpload } from "./atlasClient";
import { inspectBrowserSigmfLayoutForAtlas, type AtlasSigmfLayoutCompatibility } from "./atlasSigmfCompatibility";
import type { PreparedRecordingExport, PreparedRecordingFile } from "./recordingExportFormat";
import type { SigmfMetadata } from "./sigmf";
import { IncrementalSha256 } from "./sha256";

const HASH_CHUNK_BYTES = 1024 * 1024;
const CLIENT_MAX_INFLIGHT_PARTS = 2;

interface TransferSource {
  name: string;
  mediaType: string;
  size: number;
  view(start: number, end: number): Uint8Array;
}
interface HashedSource { source: TransferSource; sha256: string; partHashes: string[]; partSize: number }

export type AtlasTransferState = "idle" | "checking" | "authenticating" | "hashing" | "uploading" | "completing" | "registering" | "importing" | "saved" | "cancelled" | "failed";
export interface AtlasTransferSnapshot {
  state: AtlasTransferState;
  generation: number;
  bytesTransferred: string;
  totalBytes: string;
  activeParts: number;
  peakActiveParts: number;
  peakBufferedBytes: number;
  recordingId?: string;
  recordingRevisionId?: string;
  recordingUrl?: string;
  errorCode?: string;
  message?: string;
}
export interface AtlasTransferRequest {
  operatorToken: string;
  title: string;
  sourceKind?: "real" | "synthetic" | "unknown";
  analyzeAfterSave?: boolean;
}
export interface AtlasTransferResult {
  recordingId: string;
  recordingRevisionId: string;
  recordingUrl: string;
  dataSha256: string;
  metadataSha256: string;
  compatibility: AtlasSigmfLayoutCompatibility;
  analysis: { status: "not-requested" | "unavailable" | "scheduled" | "failed"; reason?: string; run?: AtlasAnalysisRun };
}
export interface AtlasTransferControllerOptions {
  client: AtlasClient;
  pollDelay?: (signal: AbortSignal) => Promise<void>;
  maxPolls?: number;
  idFactory?: () => string;
}

export class AtlasTransferFailure extends Error {
  constructor(readonly code: string, message: string, readonly cause?: unknown) { super(message); this.name = "AtlasTransferFailure"; }
}

function source(file: PreparedRecordingFile): TransferSource {
  const bytes = typeof file.contents === "string" ? new TextEncoder().encode(file.contents) : file.contents;
  return { name: file.name, mediaType: file.type, size: bytes.byteLength, view: (start, end) => bytes.subarray(start, end) };
}

function identifyPair(prepared: PreparedRecordingExport): { data: TransferSource; metadata: TransferSource; metadataValue: SigmfMetadata } {
  if (prepared.format !== "sigmf") throw new AtlasTransferFailure("sigmf_required", "SigIntAtlas transfer requires the prepared SigMF pair.");
  const dataFile = prepared.files.find(file => file.name.endsWith(".sigmf-data"));
  const metadataFile = prepared.files.find(file => file.name.endsWith(".sigmf-meta"));
  if (!dataFile || !metadataFile || typeof metadataFile.contents !== "string" || !(dataFile.contents instanceof Uint8Array)) {
    throw new AtlasTransferFailure("invalid_prepared_pair", "Prepared SigMF data and metadata files are incomplete.");
  }
  let metadataValue: SigmfMetadata;
  try { metadataValue = JSON.parse(metadataFile.contents) as SigmfMetadata; }
  catch (error) { throw new AtlasTransferFailure("invalid_metadata", "Prepared SigMF metadata is not valid JSON.", error); }
  return { data: source(dataFile), metadata: source(metadataFile), metadataValue };
}

function positiveSafeDecimal(value: string, field: string): number {
  if (!/^[1-9][0-9]*$/.test(value)) throw new AtlasTransferFailure("invalid_capabilities", `SigIntAtlas ${field} is invalid.`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new AtlasTransferFailure("unsupported_capabilities", `SigIntAtlas ${field} exceeds this browser client's safe bounded range.`);
  return parsed;
}

function hashSource(item: TransferSource, partSize: number): HashedSource {
  const whole = new IncrementalSha256();
  const partHashes: string[] = [];
  for (let partStart = 0; partStart < item.size; partStart += partSize) {
    const part = new IncrementalSha256();
    const partEnd = Math.min(item.size, partStart + partSize);
    for (let offset = partStart; offset < partEnd; offset += HASH_CHUNK_BYTES) {
      const view = item.view(offset, Math.min(partEnd, offset + HASH_CHUNK_BYTES));
      whole.update(view); part.update(view);
    }
    partHashes.push(part.hex());
  }
  return { source: item, sha256: whole.hex(), partHashes, partSize };
}

function failure(error: unknown): AtlasTransferFailure {
  if (error instanceof AtlasTransferFailure) return error;
  if (error instanceof AtlasRequestError) {
    const code = error.status === 401 ? "session_expired" : error.code;
    const hint = error.status === 403 ? " Check the configured same-origin proxy, trusted Host/Origin and CSRF session." : "";
    return new AtlasTransferFailure(code, `${error.message}${hint}`, error);
  }
  if (error instanceof DOMException && error.name === "AbortError") return new AtlasTransferFailure("cancelled", "SigIntAtlas transfer was cancelled.", error);
  return new AtlasTransferFailure("transfer_failed", error instanceof Error ? error.message : "SigIntAtlas transfer failed.", error);
}

export class AtlasTransferController {
  private prepared: PreparedRecordingExport;
  private readonly client: AtlasClient;
  private readonly pollDelay: NonNullable<AtlasTransferControllerOptions["pollDelay"]>;
  private readonly maxPolls: number;
  private readonly idFactory: () => string;
  private generation = 0;
  private pairId: string;
  private active?: Promise<AtlasTransferResult>;
  private aborter?: AbortController;
  private result?: AtlasTransferResult;
  private uploadIds: Partial<Record<"data" | "metadata", string>> = {};
  private createAttempts: Record<"data" | "metadata", number> = { data: 1, metadata: 1 };
  private metadataEncodingBytes = 0;
  private readonly listeners = new Set<(snapshot: AtlasTransferSnapshot) => void>();
  private snapshot: AtlasTransferSnapshot = { state: "idle", generation: 0, bytesTransferred: "0", totalBytes: "0", activeParts: 0, peakActiveParts: 0, peakBufferedBytes: 0 };

  constructor(prepared: PreparedRecordingExport, options: AtlasTransferControllerOptions) {
    this.prepared = prepared; this.client = options.client;
    this.pollDelay = options.pollDelay ?? (signal => new Promise((resolve, reject) => {
      const timer = setTimeout(resolve, 250);
      signal.addEventListener("abort", () => { clearTimeout(timer); reject(signal.reason ?? new DOMException("Cancelled", "AbortError")); }, { once: true });
    }));
    this.maxPolls = options.maxPolls ?? 240;
    this.idFactory = options.idFactory ?? (() => crypto.randomUUID());
    this.pairId = this.idFactory();
  }

  getSnapshot(): AtlasTransferSnapshot { return { ...this.snapshot }; }
  subscribe(listener: (snapshot: AtlasTransferSnapshot) => void): () => void {
    this.listeners.add(listener);
    listener(this.getSnapshot());
    return () => this.listeners.delete(listener);
  }

  start(request: AtlasTransferRequest): Promise<AtlasTransferResult> {
    if (this.result) return Promise.resolve(this.result);
    if (this.active) return this.active;
    const generation = ++this.generation;
    const aborter = new AbortController(); this.aborter = aborter;
    this.update({ state: "checking", generation, errorCode: undefined, message: undefined });
    const active = this.run(request, generation, aborter.signal)
      .then(result => { this.assertGeneration(generation); this.result = result; this.update({ state: "saved", recordingId: result.recordingId, recordingRevisionId: result.recordingRevisionId, recordingUrl: result.recordingUrl }); return result; })
      .catch(error => { const problem = failure(error); if (generation === this.generation) this.update({ state: problem.code === "cancelled" ? "cancelled" : "failed", errorCode: problem.code, message: problem.message }); throw problem; })
      .finally(() => { if (this.active === active) this.active = undefined; if (this.aborter === aborter) this.aborter = undefined; });
    this.active = active;
    return active;
  }

  async cancel(): Promise<void> {
    if (this.result) return;
    ++this.generation;
    this.aborter?.abort(new DOMException("Cancelled", "AbortError"));
    const ids = Object.values(this.uploadIds);
    await Promise.all(ids.map(id => this.client.abortUpload(id).catch(() => undefined)));
    this.update({ state: "cancelled", generation: this.generation, activeParts: 0, errorCode: "cancelled", message: "Transfer cancelled; no saved recording was deleted." });
  }

  async replacePrepared(prepared: PreparedRecordingExport): Promise<void> {
    if (this.result) throw new AtlasTransferFailure("already_saved", "A saved recording cannot be replaced or deleted by a capture replacement.");
    await this.cancel();
    this.prepared = prepared; this.pairId = this.idFactory(); this.uploadIds = {}; this.createAttempts = { data: 1, metadata: 1 };
    this.snapshot = { state: "idle", generation: this.generation, bytesTransferred: "0", totalBytes: "0", activeParts: 0, peakActiveParts: 0, peakBufferedBytes: 0 };
    this.notify();
  }

  private async run(request: AtlasTransferRequest, generation: number, signal: AbortSignal): Promise<AtlasTransferResult> {
    const pair = identifyPair(this.prepared);
    this.metadataEncodingBytes = pair.metadata.size;
    this.update({ peakBufferedBytes: Math.max(this.snapshot.peakBufferedBytes, this.metadataEncodingBytes) });
    const compatibility = inspectBrowserSigmfLayoutForAtlas(pair.metadataValue, pair.data.size);
    if (!compatibility.archiveEligible) throw new AtlasTransferFailure("archive_ineligible", compatibility.issues.map(item => item.message).join(" "));
    const capabilities = await this.client.capabilities(signal);
    this.validateCapabilities(capabilities, pair);
    const partSize = positiveSafeDecimal(capabilities.upload_part_bytes, "upload_part_bytes");
    const concurrency = Math.max(1, Math.min(CLIENT_MAX_INFLIGHT_PARTS, capabilities.max_inflight_parts));
    this.assertGeneration(generation);
    this.update({ state: "authenticating", totalBytes: String(pair.data.size + pair.metadata.size) });
    await this.client.login(request.operatorToken, signal);
    this.assertGeneration(generation);
    this.update({ state: "hashing" });
    const data = hashSource(pair.data, partSize), metadata = hashSource(pair.metadata, partSize);
    this.assertGeneration(generation);
    const dataUpload = await this.transferFile("data", data, concurrency, generation, signal);
    const metadataUpload = await this.transferFile("metadata", metadata, concurrency, generation, signal);
    this.update({ state: "registering" });
    const registration = await this.client.registerRecording({
      title: request.title, source_kind: request.sourceKind ?? "unknown", data_upload_id: dataUpload.id,
      metadata_upload_id: metadataUpload.id, raw_iq: null, campaign_id: null,
    }, this.key("recording"), signal);
    this.assertGeneration(generation);
    this.update({ state: "importing" });
    const imported = await this.pollRegistration(registration, signal, generation);
    if (!imported.recording_id) throw new AtlasTransferFailure("invalid_registration", "SigIntAtlas completed the import without a recording id.");
    const recording = await this.pollRecording(imported.recording_id, signal, generation);
    const recordingUrl = `/#/recordings/${recording.id}`;
    const base = { recordingId: recording.id, recordingRevisionId: recording.current_revision_id!, recordingUrl, dataSha256: data.sha256, metadataSha256: metadata.sha256, compatibility };
    this.update({ state: "saved", recordingId: recording.id, recordingRevisionId: recording.current_revision_id!, recordingUrl });

    if (!request.analyzeAfterSave) return { ...base, analysis: { status: "not-requested" } };
    const analysis = capabilities.analysis;
    if (!compatibility.analysisEligible) return { ...base, analysis: { status: "unavailable", reason: compatibility.issues.map(item => item.message).join(" ") } };
    if (!analysis?.available || !analysis.operations.includes("identify") || !analysis.profiles.includes("offline-bounded-v1")) {
      return { ...base, analysis: { status: "unavailable", reason: analysis?.unavailable_reason ?? "SigIntAtlas analysis capability is unavailable." } };
    }
    try {
      const run = await this.client.scheduleAnalysis(recording.id, { recording_revision_id: recording.current_revision_id, operation: "identify", intent: "full_scan", profile: "offline-bounded-v1", budgets: {} }, this.key("analysis"), signal);
      return { ...base, analysis: { status: "scheduled", run } };
    } catch (error) {
      const problem = failure(error);
      return { ...base, analysis: { status: "failed", reason: problem.message } };
    }
  }

  private validateCapabilities(capabilities: AtlasCapabilities, pair: { data: TransferSource; metadata: TransferSource; metadataValue: SigmfMetadata }): void {
    if (capabilities.schema_version !== "1.0.0" || !capabilities.storage_configured) throw new AtlasTransferFailure("storage_unavailable", "SigIntAtlas storage is not configured.");
    if (!capabilities.supported_sigmf_versions.includes(pair.metadataValue.global["core:version"])) throw new AtlasTransferFailure("sigmf_version_unsupported", "SigIntAtlas does not advertise this SigMF version.");
    if (!capabilities.supported_datatypes.includes(pair.metadataValue.global["core:datatype"])) throw new AtlasTransferFailure("datatype_unsupported", "SigIntAtlas does not advertise archival support for this datatype.");
    if (pair.data.size > positiveSafeDecimal(capabilities.max_data_bytes, "max_data_bytes") || pair.metadata.size > positiveSafeDecimal(capabilities.max_metadata_bytes, "max_metadata_bytes")) throw new AtlasTransferFailure("quota_rejected", "Prepared SigMF pair exceeds the advertised SigIntAtlas upload limits.");
    if (!Number.isInteger(capabilities.max_inflight_parts) || capabilities.max_inflight_parts < 1) throw new AtlasTransferFailure("invalid_capabilities", "SigIntAtlas max_inflight_parts is invalid.");
  }

  private async transferFile(role: "data" | "metadata", plan: HashedSource, concurrency: number, generation: number, signal: AbortSignal): Promise<AtlasUpload> {
    this.update({ state: "uploading" });
    let upload = await this.resolveUpload(role, plan, signal);
    this.assertUpload(upload, role, plan);
    const received = new Map(upload.parts.map(part => [part.part_number, part]));
    for (const part of upload.parts) this.assertReceipt(part.part_number, part.byte_length, part.sha256, plan);
    let nextPart = 1;
    const worker = async () => {
      while (true) {
        const partNumber = nextPart++;
        if (partNumber > plan.partHashes.length) return;
        if (received.has(partNumber)) continue;
        this.assertGeneration(generation);
        const start = (partNumber - 1) * plan.partSize, end = Math.min(plan.source.size, start + plan.partSize);
        const bytes = plan.source.view(start, end);
        this.update({ activeParts: this.snapshot.activeParts + 1, peakActiveParts: Math.max(this.snapshot.peakActiveParts, this.snapshot.activeParts + 1), peakBufferedBytes: Math.max(this.snapshot.peakBufferedBytes, this.metadataEncodingBytes + (this.snapshot.activeParts + 1) * plan.partSize) });
        try {
          const body = new Blob([bytes as Uint8Array<ArrayBuffer>], { type: "application/octet-stream" });
          const receipt = await this.client.putPart(upload.id, partNumber, body, plan.partHashes[partNumber - 1]!, signal);
          this.assertGeneration(generation); this.assertReceipt(receipt.part_number, receipt.byte_length, receipt.sha256, plan);
          received.set(partNumber, receipt);
          this.update({ bytesTransferred: String(BigInt(this.snapshot.bytesTransferred) + BigInt(receipt.byte_length)) });
        } finally { this.update({ activeParts: Math.max(0, this.snapshot.activeParts - 1) }); }
      }
    };
    await Promise.all(Array.from({ length: Math.min(concurrency, plan.partHashes.length) }, () => worker()));
    this.assertGeneration(generation);
    this.update({ state: "completing" });
    try { await this.client.completeUpload(upload.id, plan.partHashes.length, plan.sha256, this.key(`${role}-complete-${this.createAttempts[role]}`), signal); }
    catch (error) {
      if (error instanceof AtlasRequestError && [401, 403, 409, 413, 422].includes(error.status)) throw error;
      // Ambiguous completion is resolved from durable upload state below.
    }
    upload = await this.pollUpload(upload.id, signal, generation);
    this.assertUpload(upload, role, plan);
    return upload;
  }

  private async resolveUpload(role: "data" | "metadata", plan: HashedSource, signal: AbortSignal): Promise<AtlasUpload> {
    const existingId = this.uploadIds[role];
    if (existingId) {
      const existing = await this.client.getUpload(existingId, signal);
      if (!["failed", "aborted", "expired"].includes(existing.state)) return existing;
      this.createAttempts[role] += 1; delete this.uploadIds[role];
    }
    const upload = await this.client.createUpload({ role, byte_length: String(plan.source.size), filename: plan.source.name, media_type: plan.source.mediaType, sha256: plan.sha256 }, this.key(`${role}-create-${this.createAttempts[role]}`), signal);
    this.uploadIds[role] = upload.id;
    return upload;
  }

  private assertUpload(upload: AtlasUpload, role: "data" | "metadata", plan: HashedSource): void {
    if (upload.role !== role || upload.byte_length !== String(plan.source.size) || Number(upload.part_size) !== plan.partSize || upload.expected_parts !== plan.partHashes.length) throw new AtlasTransferFailure("upload_conflict", "SigIntAtlas upload state does not match the immutable prepared file.");
  }
  private assertReceipt(number: number, byteLength: string, hash: string, plan: HashedSource): void {
    const start = (number - 1) * plan.partSize, expectedLength = Math.min(plan.source.size, start + plan.partSize) - start;
    if (number < 1 || number > plan.partHashes.length || byteLength !== String(expectedLength) || hash !== plan.partHashes[number - 1]) throw new AtlasTransferFailure("conflicting_bytes", "SigIntAtlas already has conflicting bytes for this upload part.");
  }

  private async pollUpload(id: string, signal: AbortSignal, generation: number): Promise<AtlasUpload> {
    for (let count = 0; count < this.maxPolls; count += 1) {
      const upload = await this.client.getUpload(id, signal); this.assertGeneration(generation);
      if (upload.state === "complete") return upload;
      if (["failed", "aborted", "expired"].includes(upload.state)) throw new AtlasTransferFailure(upload.failure_code ?? `upload_${upload.state}`, `SigIntAtlas upload ended in ${upload.state}.`);
      await this.pollDelay(signal);
    }
    throw new AtlasTransferFailure("reconciliation_timeout", "Timed out reconciling SigIntAtlas upload completion.");
  }
  private async pollRegistration(initial: Awaited<ReturnType<AtlasClient["registerRecording"]>>, signal: AbortSignal, generation: number) {
    let value = initial;
    for (let count = 0; count < this.maxPolls; count += 1) {
      if (value.state === "complete") return value;
      if (value.state === "failed") throw new AtlasTransferFailure(value.failure_code ?? "import_failed", "SigIntAtlas recording import failed; uploaded originals remain governed by Atlas.");
      await this.pollDelay(signal); value = await this.client.getRegistration(value.id, signal); this.assertGeneration(generation);
    }
    throw new AtlasTransferFailure("reconciliation_timeout", "Timed out reconciling SigIntAtlas recording import.");
  }
  private async pollRecording(id: string, signal: AbortSignal, generation: number) {
    for (let count = 0; count < this.maxPolls; count += 1) {
      const value = await this.client.getRecording(id, signal); this.assertGeneration(generation);
      if (value.current_revision_id) return value;
      await this.pollDelay(signal);
    }
    throw new AtlasTransferFailure("reconciliation_timeout", "Saved recording has no current revision yet.");
  }
  private key(operation: string): string { return `browsersdr-${this.pairId}-${operation}`.slice(0, 200); }
  private assertGeneration(value: number): void { if (value !== this.generation) throw new DOMException("Capture replaced or transfer cancelled", "AbortError"); }
  private update(change: Partial<AtlasTransferSnapshot>): void {
    this.snapshot = { ...this.snapshot, ...change };
    this.notify();
  }
  private notify(): void {
    const snapshot = this.getSnapshot();
    for (const listener of this.listeners) listener(snapshot);
  }
}

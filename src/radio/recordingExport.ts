import { strToU8, zipSync } from "fflate";
import { recordingMetadataJson, validateRecordingMetadata, RECORDING_FORMAT, RECORDING_MAX_BYTES, RECORDING_METADATA_MAX_BYTES, type IqRecording, type RecordingStatus } from "./iqRecording";
import { createSafeRecordingBasename, createSigmfExport } from "./sigmf";

export type RecordingExportFormat = "browsersdr" | "sigmf";
export type RecordingDownloadKind = "archive" | "separate";
export type RecordingRetentionStatus = "empty" | "preparing" | "prepared" | "download-requested" | "retry-available" | "discarded";
export const RETAINED_CAPTURE_MAX_ITEMS = 1;
export const RETAINED_CAPTURE_MAX_BYTES = RECORDING_MAX_BYTES + RECORDING_METADATA_MAX_BYTES;
export const RECORDING_ARCHIVE_MAX_BYTES = RETAINED_CAPTURE_MAX_BYTES + 64 * 1024;

export interface PreparedRecordingFile { name: string; contents: Uint8Array | string; type: string }
export interface PreparedRecordingExport {
  format: RecordingExportFormat;
  basename: string;
  sampleCount: number;
  files: [PreparedRecordingFile, PreparedRecordingFile];
}
export interface RecordingRetentionSnapshot {
  status: RecordingRetentionStatus;
  format?: RecordingExportFormat;
  basename?: string;
  sampleCount?: number;
  retainedBytes: number;
  downloadRequests: number;
  error?: string;
}
export type RetainRecordingResult =
  | { status: "prepared"; prepared: PreparedRecordingExport }
  | { status: "busy" | "blocked" | "duplicate" }
  | { status: "failure"; error: Error };
export type DownloadRequestResult =
  | { status: "download-requested"; name: string; kind: RecordingDownloadKind }
  | { status: "busy" }
  | { status: "failure"; error: Error };

export async function prepareRecordingExport(recording: IqRecording, format: RecordingExportFormat): Promise<PreparedRecordingExport> {
  validateRecordingMetadata(recording.metadata, recording.data.byteLength);
  if (format === "sigmf") {
    const exported = await createSigmfExport(recording);
    return { format, basename: exported.basename, sampleCount: recording.metadata.sampleCount, files: [
      { name: exported.dataFilename, contents: exported.data, type: "application/octet-stream" },
      { name: exported.metadataFilename, contents: exported.metadataJson, type: "application/json" },
    ] };
  }
  const basename = createSafeRecordingBasename(recording.metadata.captureStartedAt);
  return { format, basename, sampleCount: recording.metadata.sampleCount, files: [
    { name: `${basename}.${recording.metadata.format === RECORDING_FORMAT ? "cu8" : "ci8"}`, contents: recording.data, type: "application/octet-stream" },
    { name: `${basename}.json`, contents: recordingMetadataJson(recording), type: "application/json" },
  ] };
}

function fileBytes(file: PreparedRecordingFile): Uint8Array {
  return typeof file.contents === "string" ? strToU8(file.contents) : file.contents;
}
function binaryBlobPart(bytes: Uint8Array): ArrayBuffer {
  if (bytes.buffer instanceof ArrayBuffer && bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength) return bytes.buffer;
  return bytes.slice().buffer as ArrayBuffer;
}
export function preparedRecordingBytes(prepared: PreparedRecordingExport): number {
  return prepared.files.reduce((total, file) => total + fileBytes(file).byteLength, 0);
}
export function createRecordingArchive(prepared: PreparedRecordingExport): PreparedRecordingFile {
  if (preparedRecordingBytes(prepared) > RETAINED_CAPTURE_MAX_BYTES) throw new Error("Recording archive input exceeds the bounded export size.");
  const entries: Record<string, [Uint8Array, { level: 0 }]> = {};
  for (const file of prepared.files) entries[file.name] = [fileBytes(file), { level: 0 }];
  const contents = zipSync(entries, { level: 0 });
  if (contents.byteLength > RECORDING_ARCHIVE_MAX_BYTES) throw new Error("Recording archive exceeds the bounded export size.");
  return { name: `${prepared.basename}.zip`, contents, type: "application/zip" };
}

export function triggerFileDownload(file: PreparedRecordingFile): void {
  const contents = typeof file.contents === "string" ? file.contents : binaryBlobPart(file.contents);
  const url = URL.createObjectURL(new Blob([contents], { type: file.type }));
  try {
    const anchor = document.createElement("a"); anchor.href = url; anchor.download = file.name; anchor.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 0);
  } catch (error) { URL.revokeObjectURL(url); throw error; }
}
export function triggerRecordingDownloads(prepared: PreparedRecordingExport): void {
  const downloads: Array<{ url: string; anchor: HTMLAnchorElement }> = [];
  try {
    for (const file of prepared.files) {
      const contents = typeof file.contents === "string" ? file.contents : binaryBlobPart(file.contents);
      const url = URL.createObjectURL(new Blob([contents], { type: file.type }));
      const anchor = document.createElement("a"); anchor.href = url; anchor.download = file.name;
      downloads.push({ url, anchor });
    }
    downloads.forEach(({ anchor }) => anchor.click());
    window.setTimeout(() => downloads.forEach(({ url }) => URL.revokeObjectURL(url)), 0);
  } catch (error) { downloads.forEach(({ url }) => URL.revokeObjectURL(url)); throw error; }
}

interface RetainedCapture {
  recording: IqRecording;
  format: RecordingExportFormat;
  prepared?: PreparedRecordingExport;
  status: Exclude<RecordingRetentionStatus, "empty" | "discarded">;
  downloadRequests: number;
  error?: Error;
}

/** Owns one completed capture from preparation through explicit discard or disclosed replacement. */
export class RecordingExportCoordinator {
  private retained?: RetainedCapture;
  private lastStatus: RecordingRetentionStatus = "empty";
  constructor(private readonly prepare = prepareRecordingExport) {}

  getSnapshot(): RecordingRetentionSnapshot {
    const retained = this.retained;
    if (!retained) return { status: this.lastStatus, retainedBytes: 0, downloadRequests: 0 };
    return {
      status: retained.status, format: retained.format, basename: retained.prepared?.basename,
      sampleCount: retained.recording.metadata.sampleCount,
      retainedBytes: retained.prepared ? preparedRecordingBytes(retained.prepared) : retained.recording.data.byteLength,
      downloadRequests: retained.downloadRequests,
      ...(retained.error ? { error: retained.error.message } : {}),
    };
  }
  get blocksNewCapture(): boolean { return Boolean(this.retained && this.retained.status !== "download-requested"); }

  retain(recording: IqRecording, format: RecordingExportFormat): Promise<RetainRecordingResult> {
    if (this.retained?.recording === recording) return Promise.resolve({ status: "duplicate" });
    if (this.retained?.status === "preparing") return Promise.resolve({ status: "busy" });
    if (this.retained && this.retained.status !== "download-requested") return Promise.resolve({ status: "blocked" });
    try {
      validateRecordingMetadata(recording.metadata, recording.data.byteLength);
      recordingMetadataJson(recording);
    } catch (error) {
      return Promise.resolve({ status: "failure", error: error instanceof Error ? error : new Error("Invalid recording.") });
    }
    const attempt: RetainedCapture = { recording, format, status: "preparing", downloadRequests: 0 };
    this.retained = attempt; this.lastStatus = "preparing";
    return this.prepareAttempt(attempt);
  }
  retryPreparation(): Promise<RetainRecordingResult> {
    const attempt = this.retained;
    if (!attempt || attempt.status !== "retry-available") return Promise.resolve({ status: "failure", error: new Error("No failed recording preparation is available to retry.") });
    attempt.status = "preparing"; attempt.error = undefined; this.lastStatus = "preparing";
    return this.prepareAttempt(attempt);
  }
  requestDownload(
    kind: RecordingDownloadKind,
    downloadFile: (file: PreparedRecordingFile) => void = triggerFileDownload,
    downloadPair: (prepared: PreparedRecordingExport) => void = triggerRecordingDownloads,
  ): DownloadRequestResult {
    const retained = this.retained;
    if (!retained?.prepared) return { status: "failure", error: new Error("No prepared recording is available to download.") };
    if (retained.status === "preparing") return { status: "busy" };
    try {
      let name: string;
      if (kind === "archive") { const archive = createRecordingArchive(retained.prepared); name = archive.name; downloadFile(archive); }
      else { name = retained.prepared.basename; downloadPair(retained.prepared); }
      retained.downloadRequests += 1; retained.status = "download-requested"; retained.error = undefined; this.lastStatus = retained.status;
      return { status: "download-requested", name, kind };
    } catch (error) {
      retained.status = "retry-available";
      retained.error = error instanceof Error ? error : new Error("Recording download request failed.");
      this.lastStatus = retained.status;
      return { status: "failure", error: retained.error };
    }
  }
  discard(): void { this.retained = undefined; this.lastStatus = "discarded"; }

  private async prepareAttempt(attempt: RetainedCapture): Promise<RetainRecordingResult> {
    try {
      const prepared = await this.prepare(attempt.recording, attempt.format);
      if (this.retained !== attempt) return { status: "duplicate" };
      if (preparedRecordingBytes(prepared) > RETAINED_CAPTURE_MAX_BYTES) throw new Error("Prepared recording exceeds the retained-capture memory budget.");
      attempt.prepared = prepared; attempt.status = "prepared"; this.lastStatus = attempt.status;
      return { status: "prepared", prepared };
    } catch (error) {
      const failure = error instanceof Error ? error : new Error("Recording preparation failed.");
      if (this.retained === attempt) { attempt.status = "retry-available"; attempt.error = failure; this.lastStatus = attempt.status; }
      return { status: "failure", error: failure };
    }
  }
}

export class RecordingFormatLatch {
  private active?: RecordingExportFormat;
  get locked(): boolean { return this.active !== undefined; }
  begin(format: RecordingExportFormat): void { this.active = format; }
  complete(fallback: RecordingExportFormat): RecordingExportFormat { const format = this.active ?? fallback; this.active = undefined; return format; }
}
export function formatControlDisabled(status: RecordingStatus | undefined, preparing: boolean): boolean { return Boolean(status) || preparing; }

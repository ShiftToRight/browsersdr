import { strToU8, zipSync } from "fflate";
import { recordingMetadataJson, validateRecordingMetadata, RECORDING_FORMAT, RECORDING_MAX_BYTES, RECORDING_METADATA_MAX_BYTES, type IqRecording } from "./iqRecording";
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

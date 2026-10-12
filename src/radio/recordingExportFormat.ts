import { BLADERF_SC16_RECORDING_FORMAT } from "./bladerfRecording";
import { strToU8, zipSync } from "fflate";
import { recordingDataBlob, recordingDataByteLength, recordingMetadataJson, validateRecordingMetadata, RECORDING_MAX_BYTES, RECORDING_METADATA_MAX_BYTES, type IqRecording } from "./iqRecording";
import { STREAMING_RECORDING_MAX_BYTES } from "./recordingSpool";
import { createSafeRecordingBasename, createSigmfExport } from "./sigmf";
import { CI16_RECORDING_FORMAT } from "./ci16Recording";

export type RecordingExportFormat = "browsersdr" | "sigmf";
export type RecordingDownloadKind = "archive" | "separate";
export type RecordingRetentionStatus = "empty" | "preparing" | "prepared" | "download-requested" | "retry-available" | "storage-failed" | "discarded";
export const RETAINED_CAPTURE_MAX_ITEMS = 1;
export const RETAINED_CAPTURE_MAX_BYTES = STREAMING_RECORDING_MAX_BYTES + RECORDING_METADATA_MAX_BYTES;
export const RECORDING_ARCHIVE_INPUT_MAX_BYTES = RECORDING_MAX_BYTES + RECORDING_METADATA_MAX_BYTES;
export const RECORDING_ARCHIVE_MAX_BYTES = RECORDING_ARCHIVE_INPUT_MAX_BYTES + 64 * 1024;
/** Chrome can resolve a small sidecar immediately while it is still opening a
 * large file-backed Blob. Revoking on the next task makes that pending download
 * fail with a misleading network error. Keep URLs alive long enough for the
 * browser download manager to acquire both Blob handles. */
export const RECORDING_DOWNLOAD_URL_LIFETIME_MS = 60_000;

export interface PreparedRecordingFile { name: string; contents: Uint8Array | Blob | string; type: string }
export interface PreparedRecordingExport {
  format: RecordingExportFormat;
  basename: string;
  sampleCount: number;
  files: [PreparedRecordingFile, PreparedRecordingFile];
}
export interface RecordingRetentionSnapshot {
  libraryId?: string;
  status: RecordingRetentionStatus;
  format?: RecordingExportFormat;
  basename?: string;
  sampleCount?: number;
  sampleRateHz?: number;
  retainedBytes: number;
  downloadRequests: number;
  error?: string;
  captureWarning?: string;
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
  const byteLength = recordingDataByteLength(recording);
  validateRecordingMetadata(recording.metadata, byteLength, STREAMING_RECORDING_MAX_BYTES);
  if (format === "sigmf") {
    const exported = await createSigmfExport(recording);
    return { format, basename: exported.basename, sampleCount: recording.metadata.sampleCount, files: [
      { name: exported.dataFilename, contents: exported.dataBlob ?? exported.data, type: "application/octet-stream" },
      { name: exported.metadataFilename, contents: exported.metadataJson, type: "application/json" },
    ] };
  }
  if (recording.metadata.format === BLADERF_SC16_RECORDING_FORMAT)
    throw new Error("bladeRF SC16 Q11 recordings are exported as SigMF ci16_le pairs with explicit Q11 metadata.");
  if (recording.metadata.format === CI16_RECORDING_FORMAT)
    throw new Error("USRP B205-mini recordings are exported as SigMF ci16_le pairs.");
  const data = recording.dataBlob ? await recordingDataBlob(recording) : recording.data;
  const basename = createSafeRecordingBasename(recording.metadata.captureStartedAt);
  return { format, basename, sampleCount: recording.metadata.sampleCount, files: [
    { name: `${basename}.${recording.metadata.sampleEncoding === "signed-16-bit-little-endian" ? "ci16" : recording.metadata.sampleEncoding === "unsigned-8-bit" ? "cu8" : "ci8"}`, contents: data, type: "application/octet-stream" },
    { name: `${basename}.json`, contents: recordingMetadataJson(recording), type: "application/json" },
  ] };
}
function fileBytes(file: PreparedRecordingFile): Uint8Array {
  if (file.contents instanceof Blob) throw new Error("ZIP download is limited to bounded in-memory recordings; request the separate files instead.");
  return typeof file.contents === "string" ? strToU8(file.contents) : file.contents;
}
function binaryBlobPart(bytes: Uint8Array): ArrayBuffer {
  if (bytes.buffer instanceof ArrayBuffer && bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength) return bytes.buffer;
  return bytes.slice().buffer as ArrayBuffer;
}
export function preparedRecordingBytes(prepared: PreparedRecordingExport): number {
  return prepared.files.reduce((total, file) => total + (file.contents instanceof Blob
    ? file.contents.size
    : fileBytes(file).byteLength), 0);
}
export function createRecordingArchive(prepared: PreparedRecordingExport): PreparedRecordingFile {
  if (preparedRecordingBytes(prepared) > RECORDING_ARCHIVE_INPUT_MAX_BYTES) throw new Error("Recording archive input exceeds the bounded ZIP size; request separate files.");
  const entries: Record<string, [Uint8Array, { level: 0 }]> = {};
  for (const file of prepared.files) entries[file.name] = [fileBytes(file), { level: 0 }];
  const contents = zipSync(entries, { level: 0 });
  if (contents.byteLength > RECORDING_ARCHIVE_MAX_BYTES) throw new Error("Recording archive exceeds the bounded export size.");
  return { name: `${prepared.basename}.zip`, contents, type: "application/zip" };
}

export function triggerFileDownload(file: PreparedRecordingFile): void {
  const contents = file.contents instanceof Blob ? file.contents
    : typeof file.contents === "string" ? file.contents : binaryBlobPart(file.contents);
  const url = URL.createObjectURL(new Blob([contents], { type: file.type }));
  try {
    const anchor = document.createElement("a"); anchor.href = url; anchor.download = file.name; anchor.click();
    window.setTimeout(
      () => URL.revokeObjectURL(url),
      RECORDING_DOWNLOAD_URL_LIFETIME_MS,
    );
  } catch (error) { URL.revokeObjectURL(url); throw error; }
}
export function triggerRecordingDownloads(prepared: PreparedRecordingExport): void {
  const downloads: Array<{ url: string; anchor: HTMLAnchorElement }> = [];
  try {
    for (const file of prepared.files) {
      const contents = file.contents instanceof Blob ? file.contents
        : typeof file.contents === "string" ? file.contents : binaryBlobPart(file.contents);
      const url = URL.createObjectURL(new Blob([contents], { type: file.type }));
      const anchor = document.createElement("a"); anchor.href = url; anchor.download = file.name;
      downloads.push({ url, anchor });
    }
    downloads.forEach(({ anchor }) => anchor.click());
    window.setTimeout(
      () => downloads.forEach(({ url }) => URL.revokeObjectURL(url)),
      RECORDING_DOWNLOAD_URL_LIFETIME_MS,
    );
  } catch (error) { downloads.forEach(({ url }) => URL.revokeObjectURL(url)); throw error; }
}

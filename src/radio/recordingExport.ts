import { RecordingJobs } from "./recordingJobs";
import { recordingDataBlob, recordingDataByteLength, recordingMetadataJson, validateRecordingMetadata, type IqRecording, type RecordingStatus } from "./iqRecording";
import { prepareRecordingExport, preparedRecordingBytes, createRecordingArchive, triggerFileDownload, triggerRecordingDownloads, RECORDING_ARCHIVE_INPUT_MAX_BYTES, RECORDING_DOWNLOAD_URL_LIFETIME_MS, RETAINED_CAPTURE_MAX_BYTES,
  type PreparedRecordingExport, type PreparedRecordingFile, type RecordingExportFormat, type RecordingDownloadKind, type RecordingRetentionStatus, type RecordingRetentionSnapshot, type RetainRecordingResult, type DownloadRequestResult } from "./recordingExportFormat";
import { STREAMING_RECORDING_MAX_BYTES } from "./recordingSpool";
export * from "./recordingExportFormat";

interface RetainedCapture {
  recording: IqRecording;
  format: RecordingExportFormat;
  prepared?: PreparedRecordingExport;
  status: Exclude<RecordingRetentionStatus, "empty" | "discarded">;
  downloadRequests: number;
  error?: Error;
  releaseAfter?: number;
}

/** Owns one completed capture from preparation through explicit discard or disclosed replacement. */
export class RecordingExportCoordinator {
  private retained?: RetainedCapture;
  private lastStatus: RecordingRetentionStatus = "empty";
  private readonly jobs = typeof Worker === "undefined" ? undefined : new RecordingJobs();
  private downloading = false;
  constructor(private readonly prepare?: typeof prepareRecordingExport) {}
  cancel(): void { this.jobs?.cancel(); }


  getSnapshot(): RecordingRetentionSnapshot {
    const retained = this.retained;
    if (!retained) return { status: this.lastStatus, retainedBytes: 0, downloadRequests: 0 };
    return {
      ...(retained.recording.libraryId && retained.status !== "storage-failed" && retained.status !== "preparing" ? { libraryId: retained.recording.libraryId } : {}),
      status: retained.status, format: retained.format, basename: retained.prepared?.basename,
      sampleCount: retained.recording.metadata.sampleCount,
      sampleRateHz: retained.recording.metadata.sampleRateHz,
      captureWarning: retained.recording.metadata.captureWarning,
      retainedBytes: retained.prepared ? preparedRecordingBytes(retained.prepared) : recordingDataByteLength(retained.recording),
      downloadRequests: retained.downloadRequests,
      ...(retained.error ? { error: retained.error.message } : {}),
    };
  }
  get blocksNewCapture(): boolean { return this.downloading || Boolean(this.retained && this.retained.status !== "download-requested"); }

  retain(recording: IqRecording, format: RecordingExportFormat): Promise<RetainRecordingResult> {
    if (this.downloading) return Promise.resolve({ status: "busy" });
    if (this.retained?.recording === recording) return Promise.resolve({ status: "duplicate" });
    if (this.retained?.status === "preparing") return Promise.resolve({ status: "busy" });
    if (this.retained && this.retained.status !== "download-requested") return Promise.resolve({ status: "blocked" });
    try {
      validateRecordingMetadata(recording.metadata, recordingDataByteLength(recording), STREAMING_RECORDING_MAX_BYTES);
      recordingMetadataJson(recording);
    } catch (error) {
      return Promise.resolve({ status: "failure", error: error instanceof Error ? error : new Error("Invalid recording.") });
    }
    const previous = this.retained;
    const attempt: RetainedCapture = { recording, format, status: "preparing", downloadRequests: 0 };
    this.retained = attempt; this.lastStatus = "preparing";
    if (previous) this.releaseRecording(previous);
    return this.prepareAttempt(attempt);
  }
  retryPreparation(): Promise<RetainRecordingResult> {
    const attempt = this.retained;
    if (!attempt || attempt.status !== "retry-available") return Promise.resolve({ status: "failure", error: new Error("No failed recording preparation is available to retry.") });
    attempt.status = "preparing"; attempt.error = undefined; this.lastStatus = "preparing";
    return this.prepareAttempt(attempt);
  }
  async requestDirectFileDownload(
    downloadPair: (prepared: PreparedRecordingExport) => void = triggerRecordingDownloads,
  ): Promise<DownloadRequestResult> {
    const retained = this.retained;
    if (!retained) return { status: "failure", error: new Error("No completed recording is available to download.") };
    if (this.downloading || retained.status === "preparing") return { status: "busy" };
    this.downloading = true;
    try {
      // This is an explicit recovery path for environments where the module
      // worker cannot be loaded. Keep it separate because hashing a large
      // SigMF capture on the UI thread can briefly make the page less responsive.
      const prepared = retained.prepared ?? await prepareRecordingExport(retained.recording, retained.format);
      if (this.retained !== retained) throw new DOMException("Recording export cancelled", "AbortError");
      if (preparedRecordingBytes(prepared) > RETAINED_CAPTURE_MAX_BYTES)
        throw new Error("Prepared recording exceeds the retained-capture storage budget.");
      downloadPair(prepared);
      retained.prepared = prepared;
      retained.downloadRequests += 1;
      retained.status = "download-requested";
      retained.releaseAfter = Date.now() + RECORDING_DOWNLOAD_URL_LIFETIME_MS;
      retained.error = undefined;
      this.lastStatus = retained.status;
      return { status: "download-requested", name: prepared.basename, kind: "separate" };
    } catch (error) {
      retained.status = "retry-available";
      retained.error = error instanceof Error ? error : new Error("Direct recording download request failed.");
      if (this.retained === retained) this.lastStatus = retained.status;
      return { status: "failure", error: retained.error };
    } finally { this.downloading = false; }
  }
  async requestDownload(
    kind: RecordingDownloadKind,
    downloadFile: (file: PreparedRecordingFile) => void = triggerFileDownload,
    downloadPair: (prepared: PreparedRecordingExport) => void = triggerRecordingDownloads,
    signal?: AbortSignal,
  ): Promise<DownloadRequestResult> {
    const retained = this.retained;
    if (signal?.aborted) return { status: "failure", error: new DOMException("Recording export cancelled", "AbortError") };
    if (!retained?.prepared) return { status: "failure", error: new Error("No prepared recording is available to download.") };
    if (retained.status === "preparing" || this.downloading) return { status: "busy" };
    this.downloading = true;
    try {
      let name: string;
      if (kind === "archive") {
        if (preparedRecordingBytes(retained.prepared) > RECORDING_ARCHIVE_INPUT_MAX_BYTES) throw new Error("ZIP download is limited to 32 MiB; request the separate files instead.");
        const archive = this.jobs ? await this.jobs.archive(retained.prepared, signal) : createRecordingArchive(retained.prepared);
        if (this.retained !== retained || signal?.aborted) throw new DOMException("Recording export cancelled", "AbortError");
        name = archive.name; downloadFile(archive);
      }
      else { name = retained.prepared.basename; downloadPair(retained.prepared); }
      retained.downloadRequests += 1; retained.status = "download-requested"; retained.error = undefined; this.lastStatus = retained.status;
      retained.releaseAfter = Date.now() + RECORDING_DOWNLOAD_URL_LIFETIME_MS;
      return { status: "download-requested", name, kind };
    } catch (error) {
      retained.status = "retry-available";
      retained.error = error instanceof Error ? error : new Error("Recording download request failed.");
      if (this.retained === retained) this.lastStatus = retained.status;
      return { status: "failure", error: retained.error };
    } finally { this.downloading = false; }
  }
  discard(): void {
    this.cancel();
    const retained = this.retained;
    this.retained = undefined;
    this.lastStatus = "discarded";
    if (retained) this.releaseRecording(retained);
  }

  private releaseRecording(retained: RetainedCapture): void {
    const release = retained.recording.releaseData;
    if (!release) return;
    const delay = Math.max(0, (retained.releaseAfter ?? 0) - Date.now());
    const timer = globalThis.setTimeout(() => void release(), delay);
    if (typeof timer === "object" && "unref" in timer)
      (timer as ReturnType<typeof setTimeout> & { unref(): void }).unref();
  }

  private async prepareAttempt(attempt: RetainedCapture): Promise<RetainRecordingResult> {
    try {
      if (attempt.recording.dataBlob) {
        try { await recordingDataBlob(attempt.recording); }
        catch (error) {
          if (this.retained === attempt) { attempt.status = "storage-failed"; this.lastStatus = attempt.status; }
          throw error;
        }
      }
      if (this.retained !== attempt) return { status: "duplicate" };
      const prepared = await (this.prepare ? this.prepare(attempt.recording, attempt.format) : this.jobs ? this.jobs.prepare(attempt.recording, attempt.format) : prepareRecordingExport(attempt.recording, attempt.format));
      if (this.retained !== attempt) return { status: "duplicate" };
      if (preparedRecordingBytes(prepared) > RETAINED_CAPTURE_MAX_BYTES) throw new Error("Prepared recording exceeds the retained-capture storage budget.");
      attempt.prepared = prepared; attempt.status = "prepared"; this.lastStatus = attempt.status;
      return { status: "prepared", prepared };
    } catch (error) {
      const failure = error instanceof Error ? error : new Error(error && typeof error === "object" && "message" in error ? String(error.message) : "Recording preparation failed.");
      if (this.retained === attempt) { if (attempt.status !== "storage-failed") attempt.status = "retry-available"; attempt.error = failure; this.lastStatus = attempt.status; }
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

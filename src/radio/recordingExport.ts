import { RecordingJobs } from "./recordingJobs";
import { recordingMetadataJson, validateRecordingMetadata, type IqRecording, type RecordingStatus } from "./iqRecording";
import { prepareRecordingExport, preparedRecordingBytes, createRecordingArchive, triggerFileDownload, triggerRecordingDownloads, RETAINED_CAPTURE_MAX_BYTES,
  type PreparedRecordingExport, type PreparedRecordingFile, type RecordingExportFormat, type RecordingDownloadKind, type RecordingRetentionStatus, type RecordingRetentionSnapshot, type RetainRecordingResult, type DownloadRequestResult } from "./recordingExportFormat";
export * from "./recordingExportFormat";

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
  private readonly jobs = typeof Worker === "undefined" ? undefined : new RecordingJobs();
  private downloading = false;
  constructor(private readonly prepare?: typeof prepareRecordingExport) {}
  cancel(): void { this.jobs?.cancel(); }


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
  get blocksNewCapture(): boolean { return this.downloading || Boolean(this.retained && this.retained.status !== "download-requested"); }

  retain(recording: IqRecording, format: RecordingExportFormat): Promise<RetainRecordingResult> {
    if (this.downloading) return Promise.resolve({ status: "busy" });
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
        if (preparedRecordingBytes(retained.prepared) > RETAINED_CAPTURE_MAX_BYTES) throw new Error("Archive exceeds capacity.");
        const archive = this.jobs ? await this.jobs.archive(retained.prepared, signal) : createRecordingArchive(retained.prepared);
        if (this.retained !== retained || signal?.aborted) throw new DOMException("Recording export cancelled", "AbortError");
        name = archive.name; downloadFile(archive);
      }
      else { name = retained.prepared.basename; downloadPair(retained.prepared); }
      retained.downloadRequests += 1; retained.status = "download-requested"; retained.error = undefined; this.lastStatus = retained.status;
      return { status: "download-requested", name, kind };
    } catch (error) {
      retained.status = "retry-available";
      retained.error = error instanceof Error ? error : new Error("Recording download request failed.");
      if (this.retained === retained) this.lastStatus = retained.status;
      return { status: "failure", error: retained.error };
    } finally { this.downloading = false; }
  }
  discard(): void { this.cancel(); this.retained = undefined; this.lastStatus = "discarded"; }

  private async prepareAttempt(attempt: RetainedCapture): Promise<RetainRecordingResult> {
    try {
      const prepared = await (this.prepare ? this.prepare(attempt.recording, attempt.format) : this.jobs ? this.jobs.prepare(attempt.recording, attempt.format) : prepareRecordingExport(attempt.recording, attempt.format));
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

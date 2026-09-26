import { validateRecordingMetadata, type IqRecording, type IqRecordingMetadata } from "./iqRecording";
import { preparedRecordingBytes, RETAINED_CAPTURE_MAX_BYTES, type PreparedRecordingExport, type PreparedRecordingFile, type RecordingExportFormat } from "./recordingExportFormat";
import { defaultDiagnosticRecorder } from "../diagnostics/diagnosticRecorder";

export type RecordingJob =
  | { type: "prepare"; data: Blob; metadata: IqRecordingMetadata; format: RecordingExportFormat }
  | { type: "archive"; prepared: Omit<PreparedRecordingExport, "files">; files: Array<{ name: string; type: string; data: Blob }> };
export type RecordingJobReply = { ok: false; error: string } | { ok: true; prepared?: Omit<PreparedRecordingExport, "files">; files?: Array<Omit<PreparedRecordingFile, "contents"> & { contents?: string }>; archive?: PreparedRecordingFile };
export type RecordingJobWorker = Pick<Worker, "postMessage" | "onmessage" | "onerror" | "terminate">;

/** One bounded, short-lived job per coordinator. Immutable Blob snapshots keep
 * the original capture retryable if loading, hashing, ZIP or worker startup fails. */
export class RecordingJobs {
  private cancelActive?: () => void;
  constructor(private readonly factory = (): RecordingJobWorker => new Worker(new URL("../workers/recording.worker.ts", import.meta.url), { type: "module" })) {}
  cancel(): void { this.cancelActive?.(); }
  private run(input: RecordingJob, signal?: AbortSignal): Promise<RecordingJobReply & { ok: true }> {
    if (this.cancelActive) return Promise.reject(new Error("A recording job is already active."));
    if (signal?.aborted) return Promise.reject(new DOMException("Recording export cancelled", "AbortError"));
    return new Promise((resolve, reject) => {
      const worker = this.factory();
      let settled = false;
      const finish = () => { if (settled) return false; settled = true; clearTimeout(timer); worker.onmessage = null; worker.onerror = null; worker.terminate(); signal?.removeEventListener("abort", cancel); this.cancelActive = undefined; return true; };
      const cancel = () => { if (!finish()) return; reject(new DOMException("Recording export cancelled", "AbortError")); };
      const timer = setTimeout(() => { if (!finish()) return; const error = new Error("Recording worker timed out. The original capture is available for retry."); defaultDiagnosticRecorder.record({ area: "recording", code: "RECORDING_WORKER_TIMEOUT", severity: "error", operation: input.type, error }); reject(error); }, 30_000);
      this.cancelActive = cancel; signal?.addEventListener("abort", cancel, { once: true });
      worker.onerror = () => { if (!finish()) return; const error = new Error("Recording worker failed. The original capture is available for retry."); defaultDiagnosticRecorder.record({ area: "recording", code: "RECORDING_WORKER_FAILURE", severity: "error", operation: input.type, error }); reject(error); };
      worker.onmessage = event => {
        const reply = event.data as RecordingJobReply; if (!finish()) return;
        if (reply.ok) resolve(reply); else reject(new Error(reply.error));
      };
      try { worker.postMessage(input); } catch (error) { finish(); reject(error); }
    });
  }
  async prepare(recording: IqRecording, format: RecordingExportFormat): Promise<PreparedRecordingExport> {
    if (this.cancelActive) throw new Error("A recording job is already active.");
    validateRecordingMetadata(recording.metadata, recording.data.byteLength);
    // Blob snapshots only the visible bytes, including a short final recording.
    const data = new Blob([recording.data as Uint8Array<ArrayBuffer>]);
    const reply = await this.run({ type: "prepare", data, metadata: recording.metadata, format });
    if (!reply.prepared || reply.files?.length !== 2) throw new Error("Invalid recording preparation response.");
    return { ...reply.prepared, files: reply.files.map(file => ({ ...file, contents: file.contents ?? recording.data })) as PreparedRecordingExport["files"] };
  }
  async archive(prepared: PreparedRecordingExport, signal?: AbortSignal): Promise<PreparedRecordingFile> {
    if (this.cancelActive) throw new Error("A recording job is already active.");
    if (preparedRecordingBytes(prepared) > RETAINED_CAPTURE_MAX_BYTES) throw new Error("Archive exceeds capacity.");
    const { files, ...metadata } = prepared;
    const reply = await this.run({ type: "archive", prepared: metadata, files: files.map(file => ({ name: file.name, type: file.type,
      data: new Blob([typeof file.contents === "string" ? file.contents : file.contents as Uint8Array<ArrayBuffer>]) })) }, signal);
    if (!reply.archive) throw new Error("Invalid recording archive response.");
    return reply.archive;
  }
}

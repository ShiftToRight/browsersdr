import { recordingMetadataJson, type IqRecording, type RecordingStatus } from "./iqRecording";
import { createSafeRecordingBasename, createSigmfExport } from "./sigmf";

export type RecordingExportFormat = "browsersdr" | "sigmf";

export interface PreparedRecordingFile {
  name: string;
  contents: Uint8Array | string;
  type: string;
}

export interface PreparedRecordingExport {
  format: RecordingExportFormat;
  basename: string;
  sampleCount: number;
  files: [PreparedRecordingFile, PreparedRecordingFile];
}

export async function prepareRecordingExport(recording: IqRecording, format: RecordingExportFormat): Promise<PreparedRecordingExport> {
  if (format === "sigmf") {
    const exported = await createSigmfExport(recording);
    return {
      format,
      basename: exported.basename,
      sampleCount: recording.metadata.sampleCount,
      files: [
        { name: exported.dataFilename, contents: exported.data, type: "application/octet-stream" },
        { name: exported.metadataFilename, contents: exported.metadataJson, type: "application/json" },
      ],
    };
  }
  const basename = createSafeRecordingBasename(recording.metadata.captureStartedAt);
  return {
    format,
    basename,
    sampleCount: recording.metadata.sampleCount,
    files: [
      { name: `${basename}.cu8`, contents: recording.data, type: "application/octet-stream" },
      { name: `${basename}.json`, contents: recordingMetadataJson(recording), type: "application/json" },
    ],
  };
}

export function triggerRecordingDownloads(prepared: PreparedRecordingExport): void {
  const downloads: Array<{ url: string; anchor: HTMLAnchorElement }> = [];
  try {
    for (const file of prepared.files) {
      const contents = typeof file.contents === "string"
        ? file.contents
        : file.contents.slice().buffer as ArrayBuffer;
      const url = URL.createObjectURL(new Blob([contents], { type: file.type }));
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = file.name;
      downloads.push({ url, anchor });
    }
    for (const { anchor } of downloads) anchor.click();
    window.setTimeout(() => {
      for (const { url } of downloads) URL.revokeObjectURL(url);
    }, 0);
  } catch (error) {
    for (const { url } of downloads) URL.revokeObjectURL(url);
    throw error;
  }
}

export type ExportAttemptResult =
  | { status: "success"; prepared: PreparedRecordingExport }
  | { status: "busy" }
  | { status: "failure"; error: Error };

export class RecordingExportCoordinator {
  private busy = false;
  private retained?: { recording: IqRecording; format: RecordingExportFormat };

  get isBusy(): boolean { return this.busy; }
  get hasRetry(): boolean { return Boolean(this.retained); }

  export(
    recording: IqRecording,
    format: RecordingExportFormat,
    download: (prepared: PreparedRecordingExport) => void = triggerRecordingDownloads,
  ): Promise<ExportAttemptResult> {
    if (this.busy) return Promise.resolve({ status: "busy" });
    this.retained = { recording, format };
    return this.run(download);
  }

  retry(download: (prepared: PreparedRecordingExport) => void = triggerRecordingDownloads): Promise<ExportAttemptResult> {
    if (!this.retained) return Promise.resolve({ status: "failure", error: new Error("No failed recording export is available to retry.") });
    return this.run(download);
  }

  private async run(download: (prepared: PreparedRecordingExport) => void): Promise<ExportAttemptResult> {
    if (this.busy) return { status: "busy" };
    const attempt = this.retained;
    if (!attempt) return { status: "failure", error: new Error("No recording export is available.") };
    this.busy = true;
    try {
      const prepared = await prepareRecordingExport(attempt.recording, attempt.format);
      download(prepared);
      if (this.retained === attempt) this.retained = undefined;
      return { status: "success", prepared };
    } catch (error) {
      return { status: "failure", error: error instanceof Error ? error : new Error("Recording export failed.") };
    } finally {
      this.busy = false;
    }
  }
}

export class RecordingFormatLatch {
  private active?: RecordingExportFormat;
  get locked(): boolean { return this.active !== undefined; }
  begin(format: RecordingExportFormat): void { this.active = format; }
  complete(fallback: RecordingExportFormat): RecordingExportFormat {
    const format = this.active ?? fallback;
    this.active = undefined;
    return format;
  }
}

export function formatControlDisabled(status: RecordingStatus | undefined, exporting: boolean): boolean {
  return Boolean(status) || exporting;
}

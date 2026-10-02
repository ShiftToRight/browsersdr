import { prepareRecordingExport, createRecordingArchive, RECORDING_ARCHIVE_INPUT_MAX_BYTES } from "../radio/recordingExportFormat";
import { validateRecordingMetadata } from "../radio/iqRecording";
import { STREAMING_RECORDING_MAX_BYTES } from "../radio/recordingSpool";
import type { RecordingJob, RecordingJobReply } from "../radio/recordingJobs";

self.onmessage = async (event: MessageEvent<RecordingJob>) => {
  try {
    const job = event.data;
    if (job.type === "prepare") {
      validateRecordingMetadata(job.metadata, job.data.size, STREAMING_RECORDING_MAX_BYTES);
      const recording = { data: new Uint8Array(), dataBlob: job.data, metadata: job.metadata };
      const { files, ...prepared } = await prepareRecordingExport(recording, job.format);
      self.postMessage({ ok: true, prepared, files: files.map(file => ({ ...file, contents: typeof file.contents === "string" ? file.contents : undefined })) } satisfies RecordingJobReply);
    } else {
      if (job.files.length !== 2 || job.files.reduce((sum, file) => sum + file.data.size, 0) > RECORDING_ARCHIVE_INPUT_MAX_BYTES) throw new Error("ZIP download is limited to 32 MiB; request the separate files instead.");
      const files = await Promise.all(job.files.map(async file => ({ name: file.name, type: file.type, contents: new Uint8Array(await file.data.arrayBuffer()) })));
      const archive = createRecordingArchive({ ...job.prepared, files: files as [typeof files[number], typeof files[number]] });
      self.postMessage({ ok: true, archive } satisfies RecordingJobReply, { transfer: [(archive.contents as Uint8Array<ArrayBuffer>).buffer] });
    }
  } catch (error) { self.postMessage({ ok: false, error: error instanceof Error ? error.message : String(error) } satisfies RecordingJobReply); }
};

import { describe, expect, it, vi } from "vitest";
import { RecordingJobs, type RecordingJobReply, type RecordingJobWorker } from "./recordingJobs";
import { createDeterministicRecordingFixture } from "../testing/recordingFixture";
import { prepareRecordingExport } from "./recordingExportFormat";
class FakeWorker implements RecordingJobWorker {
  onmessage: RecordingJobWorker["onmessage"] = null;
  onerror: RecordingJobWorker["onerror"] = null;
  postMessage = vi.fn(); terminate = vi.fn();
  reply(data: RecordingJobReply) { this.onmessage?.call(this as unknown as Worker, new MessageEvent("message", { data })); }
}
describe("bounded recording jobs", () => {
  it("keeps original bytes intact, rejects concurrent work and permits retry after worker failure", async () => {
    const workers: FakeWorker[] = [];
    const jobs = new RecordingJobs(() => { const w = new FakeWorker(); workers.push(w); return w; });
    const recording = createDeterministicRecordingFixture(64), before = recording.data.slice();
    const first = jobs.prepare(recording, "browsersdr");
    await expect(jobs.prepare(recording, "browsersdr")).rejects.toThrow(/already active/);
    workers[0]!.reply({ ok: false, error: "hash failed" }); await expect(first).rejects.toThrow("hash failed");
    expect(workers[0]!.terminate).toHaveBeenCalledTimes(1); expect(recording.data).toEqual(before);
    const retry = jobs.prepare(recording, "browsersdr");
    const { files, ...prepared } = await prepareRecordingExport(recording, "browsersdr");
    workers[1]!.reply({ ok: true, prepared, files: files.map(file => ({ ...file, contents: typeof file.contents === "string" ? file.contents : undefined })) });
    const result = await retry;
    expect(result.files[0].contents).toBe(recording.data);
    expect(result.files[1]).toEqual(files[1]);
  });
  it("cancels and terminates a job without a late reply clearing ownership of its replacement", async () => {
    const workers: FakeWorker[] = [];
    const jobs = new RecordingJobs(() => { const w = new FakeWorker(); workers.push(w); return w; });
    const capture = createDeterministicRecordingFixture(64), prepared = await prepareRecordingExport(capture, "browsersdr");
    const controller = new AbortController();
    const first = jobs.archive(prepared, controller.signal); const late = workers[0]!.onmessage!;
    controller.abort(); await expect(first).rejects.toMatchObject({ name: "AbortError" });
    const next = jobs.archive(prepared);
    late.call(workers[0] as unknown as Worker, new MessageEvent("message", { data: { ok: false, error: "late failure" } }));
    await expect(jobs.archive(prepared)).rejects.toThrow(/already active/);
    workers[1]!.reply({ ok: true, archive: { name: "capture.zip", type: "application/zip", contents: new Uint8Array([1, 2]) } });
    expect((await next).name).toBe("capture.zip"); expect(capture.data).toHaveLength(128);
  });
  it("bounds worker lifetime and keeps a timed-out capture retryable", async () => {
    vi.useFakeTimers();
    try {
      const worker = new FakeWorker(), jobs = new RecordingJobs(() => worker);
      const task = jobs.prepare(createDeterministicRecordingFixture(16), "sigmf");
      const rejected = expect(task).rejects.toThrow(/timed out/);
      await vi.advanceTimersByTimeAsync(30000); await rejected;
      expect(worker.terminate).toHaveBeenCalledOnce(); jobs.cancel();
    } finally { vi.useRealTimers(); }
  });
});

import {
  recordingDataBlob,
  recordingDataByteLength,
  type IqRecording,
} from "./iqRecording";

/** One 1 MiB read window. No whole-file reads or unbounded read-ahead. */
export class ReplayReader {
  private bytes = new Uint8Array();
  private offset = 0;
  private blob?: Blob;
  readonly size: number;
  constructor(private readonly recording: IqRecording) {
    this.size = recordingDataByteLength(recording);
  }
  async prepare(start: number, length: number): Promise<void> {
    if (
      !this.recording.dataBlob ||
      (start >= this.offset &&
        start + length <= this.offset + this.bytes.length)
    )
      return;
    this.blob ??= await recordingDataBlob(this.recording);
    if (this.blob.size !== this.size)
      throw new Error("Replay file size changed.");
    this.offset = start;
    this.bytes = new Uint8Array(
      await this.blob
        .slice(start, Math.min(this.size, start + 1024 * 1024))
        .arrayBuffer(),
    );
    if (this.bytes.length < length)
      throw new Error("Replay file is truncated or no longer readable.");
  }
  view(start: number, end: number): Uint8Array {
    if (!this.recording.dataBlob)
      return this.recording.data.subarray(start, end);
    if (start < this.offset || end > this.offset + this.bytes.length)
      throw new Error("Replay read exceeded its bounded window.");
    return this.bytes.subarray(start - this.offset, end - this.offset);
  }
}

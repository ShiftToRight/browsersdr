import {
  IqRecorder,
  CU8_FORMAT,
  type IqRecording,
  type RecordingSampleFormat,
} from "./iqRecording";
import { hackrfRecordingFormat } from "./ci8Recording";
import { bladeRfSc16RecordingFormat } from "./bladerfRecording";
import { usrpB205Ci16RecordingFormat } from "./ci16Recording";
import type { SourceSessionMetadata } from "./types";

export const EVENT_RING_MAX_BYTES = 8 * 1024 * 1024;
export const EVENT_CAPTURE_MAX_BYTES = 16 * 1024 * 1024;
export const EVENT_RUN_MAX_BYTES = 48 * 1024 * 1024;
/** Original native bytes only. One context, bounded pre-trigger ring and one
 * pending capture. Wall timeout yields a partial result, never invented samples. */
export class ActivityCapture {
  private ring: Uint8Array[] = [];
  private bytes = 0;
  private session?: SourceSessionMetadata;
  private pending?: {
    recorder: IqRecorder;
    remaining: number;
    timer: ReturnType<typeof setTimeout>;
    resolve: () => void;
  };
  private total = 0;
  private captures = 0;
  private context = "";
  private error?: string;
  constructor(
    private readonly preSeconds: number,
    private readonly postSeconds: number,
    private readonly deliver: (recording: IqRecording) => void,
  ) {
    if (
      !Number.isFinite(preSeconds) ||
      preSeconds < 0 ||
      preSeconds > 2 ||
      !Number.isFinite(postSeconds) ||
      postSeconds < 0.1 ||
      postSeconds > 10
    )
      throw new Error(
        "Event capture supports 0–2 seconds before and 0.1–10 seconds after an event.",
      );
  }
  private format(session: SourceSessionMetadata): RecordingSampleFormat {
    if (session.hackrf) return hackrfRecordingFormat(session.hackrf);
    if (session.bladerf) return bladeRfSc16RecordingFormat(session.bladerf);
    if (session.usrpB205) return usrpB205Ci16RecordingFormat(session.usrpB205);
    if (session.source === "rtl-sdr") return CU8_FORMAT;
    throw new Error("Event I/Q capture requires a native local receiver.");
  }
  observe = (
    bytes: Uint8Array,
    session: SourceSessionMetadata,
    gap?: { missingSamples: number | null; reason: string },
  ): void => {
    if (this.error) return;
    try {
      if (gap) this.reset("source-stop");
      const context = JSON.stringify([
        session.source,
        session.sessionGeneration,
        session.hardwareCenterFrequencyHz,
        session.selectedChannelFrequencyHz,
        session.actualSampleRateHz,
        session.mode,
        session.channelBandwidthHz,
        session.gainDb,
        session.rtlInput,
        session.hackrf?.captureSettings,
        session.bladerf?.rxSettings,
      ]);
      if (this.context && this.context !== context)
        this.reset("metadata-change");
      this.context = context;
      this.session = structuredClone(session);
      const format = this.format(session),
        width = format.bytesPerComplexSample;
      if (bytes.length % width || bytes.length > 1024 * 1024)
        throw new Error("Invalid native event-capture block.");
      if (this.pending) {
        const length = Math.min(bytes.length, this.pending.remaining * width);
        this.append(this.pending.recorder, bytes.subarray(0, length), session);
        this.pending.remaining -= length / width;
        if (
          this.pending.remaining <= 0 ||
          this.pending.recorder.status().state === "capacity-reached"
        )
          this.finish("user");
      }
      const max =
        Math.floor(
          Math.min(
            EVENT_RING_MAX_BYTES,
            this.preSeconds * session.actualSampleRateHz * width,
          ) / width,
        ) * width;
      if (!max) {
        this.ring = [];
        this.bytes = 0;
        return;
      }
      const copy = bytes.slice(Math.max(0, bytes.length - max));
      this.ring.push(copy);
      this.bytes += copy.length;
      while (this.bytes > max && this.ring.length) {
        const excess = this.bytes - max,
          first = this.ring[0]!;
        if (first.length <= excess) {
          this.ring.shift();
          this.bytes -= first.length;
        } else {
          this.ring[0] = first.slice(excess);
          this.bytes -= excess;
        }
      }
    } catch (error) {
      this.error = String(error);
      this.reset("source-stop");
    }
  };
  trigger(): Promise<void> {
    if (this.error) throw new Error(this.error);
    if (!this.session)
      throw new Error("No native pre-trigger input has arrived.");
    if (this.pending) throw new Error("An event capture is already active.");
    if (this.captures >= 3 || this.total >= EVENT_RUN_MAX_BYTES)
      throw new Error(
        "Event capture quota reached: three captures / 48 MiB per run.",
      );
    const session = this.session,
      format = this.format(session);
    const start = new Date(
      Date.now() -
        (this.bytes /
          format.bytesPerComplexSample /
          session.actualSampleRateHz) *
          1000,
    ).toISOString();
    const recorder = new IqRecorder(
      session,
      start,
      Math.min(EVENT_CAPTURE_MAX_BYTES, EVENT_RUN_MAX_BYTES - this.total),
      "Activity-triggered native I/Q. Pre-trigger duration is bounded by an 8 MiB ring; timestamp is a host estimate. Unsampled sweep intervals are absent.",
      undefined,
      format,
      "memory",
    );
    for (const bytes of this.ring) this.append(recorder, bytes, session);
    return new Promise((resolve) => {
      const timer = setTimeout(
        () => {
          if (this.pending?.recorder === recorder) {
            this.finish(
              "source-stop",
              "Event capture ended after its bounded wall-clock timeout; retained input is partial.",
            );
          }
        },
        Math.min(15_000, this.postSeconds * 2000 + 3000),
      );
      this.pending = {
        recorder,
        remaining: Math.floor(this.postSeconds * session.actualSampleRateHz),
        timer,
        resolve,
      };
    });
  }
  private append(
    recorder: IqRecorder,
    bytes: Uint8Array,
    session: SourceSessionMetadata,
  ) {
    if (session.source === "hackrf") recorder.appendCi8(bytes);
    else if (session.source === "bladerf") recorder.appendBladeRfSc16(bytes);
    else if (session.source === "usrp-b205") recorder.appendUsrpSc16(bytes);
    else recorder.appendCu8(bytes);
  }
  private finish(
    reason: "user" | "source-stop" | "metadata-change",
    warning?: string,
  ) {
    const pending = this.pending;
    if (!pending) return;
    this.pending = undefined;
    clearTimeout(pending.timer);
    const recording = pending.recorder.finish(reason);
    if (warning) recording.metadata.captureWarning = warning;
    this.total += recording.data.byteLength;
    ++this.captures;
    try {
      this.deliver(recording);
    } finally {
      pending.resolve();
    }
  }
  reset(reason: "source-stop" | "metadata-change" = "source-stop") {
    this.finish(reason);
    this.ring = [];
    this.bytes = 0;
    this.session = undefined;
    this.context = "";
  }
}

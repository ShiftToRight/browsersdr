import { describe, expect, it, vi, afterEach } from "vitest";
import { AudioArchive, audioArchive } from "./audioArchive";
import { PcmBatchPlayer } from "./pcmBatchPlayer";

const owner = {};
const feed = (archive: AudioArchive, left: Float32Array, right = left, rate = 8_000) => archive.push(owner, left, right, rate, "Generated test audio; not RF", () => {});
async function wav(blob: Blob) {
  const bytes = await blob.arrayBuffer();
  return { bytes, view: new DataView(bytes), text: new TextDecoder().decode(bytes) };
}
afterEach(() => { audioArchive.boundary(owner); audioArchive.setReviewing(false); audioArchive.setRewind(false); audioArchive.discard(); });

describe("decoded audio retention", () => {
  it("copies reused PCM, clamps channels and exports interoperable little-endian stereo WAV with provenance", async () => {
    const archive = new AudioArchive(); archive.startRecording();
    const left = Float32Array.of(-2, -.5, NaN, .5, 2), right = Float32Array.of(1, .25, Infinity, -.25, -1);
    feed(archive, left, right); left.fill(0); right.fill(0);
    archive.stopRecording();
    const { view, text, bytes } = await wav(archive.recordingWav());
    expect(text.slice(0, 4)).toBe("RIFF"); expect(text.slice(8, 16)).toBe("WAVEfmt ");
    expect(view.getUint32(4, true)).toBe(bytes.byteLength - 8);
    expect(view.getUint16(20, true)).toBe(1); expect(view.getUint16(22, true)).toBe(2);
    expect(view.getUint32(24, true)).toBe(8_000); expect(view.getUint32(40, true)).toBe(20);
    expect(Array.from({ length: 10 }, (_, i) => view.getInt16(44 + i * 2, true))).toEqual([-32768, 32767, -16384, 8192, 0, 0, 16384, -8192, 32767, -32768]);
    expect(text).toContain("INFOICMT"); expect(text).toContain("Generated test audio; not RF");
    expect(() => archive.startRecording()).toThrow("previous"); archive.discard(); archive.startRecording();
    expect(archive.hasRecording).toBe(false);
  });
  it("wraps exactly at sixty seconds, keeps latest stereo frames and frees disabled history", async () => {
    const archive = new AudioArchive(); archive.setRewind(true);
    feed(archive, new Float32Array(479_999).fill(.25));
    feed(archive, Float32Array.of(.5, 1, -1), Float32Array.of(-.5, -1, 1));
    expect(archive.rewindSeconds).toBe(60); expect(archive.memoryBytes).toBe(480_000 * 4);
    const { view } = await wav(archive.rewindWav(3 / 8_000));
    expect(Array.from({ length: 6 }, (_, i) => view.getInt16(44 + i * 2, true))).toEqual([16384, -16384, 32767, -32768, -32768, 32767]);
    const full = await wav(archive.rewindWav(1000)); expect(full.view.getUint32(40, true)).toBe(480_000 * 4);
    archive.setRewind(false); expect(archive.memoryBytes).toBe(0); expect(() => archive.rewindWav(5)).toThrow();
  });
  it("auto-stops at two minutes and coalesces tiny blocks without padding exported samples", async () => {
    const archive = new AudioArchive(); archive.startRecording();
    for (let i = 0; i < 17; i++) feed(archive, new Float32Array(1001).fill(.5));
    feed(archive, new Float32Array(960_000).fill(-.5));
    expect(archive.recording).toBe(false); expect(archive.recordedSeconds).toBe(120);
    expect(archive.memoryBytes).toBe(960_000 * 4); expect(archive.message).toContain("limit");
    const { view } = await wav(archive.recordingWav());
    expect(view.getUint32(40, true)).toBe(960_000 * 4);
    expect(view.getInt16(44 + 17016 * 4, true)).toBe(16384);
    expect(view.getInt16(44 + 17017 * 4, true)).toBe(-16384);
  });
  it("stops and preserves a recording at boundaries, clears rewind and restores the monitor", () => {
    const archive = new AudioArchive(); archive.setRewind(true); archive.startRecording(); const monitor = vi.fn();
    archive.push(owner, new Float32Array(8000), new Float32Array(8000), 8000, "old source", monitor);
    archive.setReviewing(true); expect(monitor).toHaveBeenLastCalledWith(true);
    archive.boundary({}); expect(archive.recording).toBe(true);
    archive.boundary(owner); expect(archive.recording).toBe(false); expect(archive.hasRecording).toBe(true);
    expect(archive.rewindSeconds).toBe(0); expect(archive.reviewing).toBe(false); expect(monitor).toHaveBeenLastCalledWith(false);
    expect(archive.revision).toBe(1);
  });
  it("separates changed rates/provenance and accepts fractional remote clock estimates", () => {
    const archive = new AudioArchive(); archive.setRewind(true); archive.startRecording();
    feed(archive, new Float32Array(12000), undefined, 12000.25);
    expect(archive.recordedSeconds).toBe(1);
    feed(archive, new Float32Array(8000)); expect(archive.recording).toBe(false); expect(archive.recordedSeconds).toBe(1); expect(archive.rewindSeconds).toBe(1);
    archive.push(owner, new Float32Array(800), new Float32Array(800), 8000, "new source", () => {});
    expect(archive.rewindSeconds).toBe(.1);
  });
  it("retains EOF rewind, rejects empty/active exports and ignores invalid rates", () => {
    const archive = new AudioArchive(); expect(archive.memoryBytes).toBe(0);
    feed(archive, new Float32Array(10)); expect(archive.memoryBytes).toBe(0);
    archive.startRecording(); expect(() => archive.recordingWav()).toThrow(); archive.setRewind(true);
    feed(archive, new Float32Array(8000)); archive.finish(owner);
    expect(archive.recording).toBe(false); expect(archive.rewindSeconds).toBe(1);
    archive.boundary(owner); expect(archive.rewindSeconds).toBe(1);
    archive.discard(); archive.startRecording(); feed(archive, new Float32Array(4000));
    expect(archive.recording).toBe(true); expect(archive.recordedSeconds).toBe(.5); expect(archive.rewindSeconds).toBe(.5);
    archive.discard(); archive.startRecording(); feed(archive, new Float32Array(1), undefined, NaN);
    expect(archive.recording).toBe(false); expect(archive.message).toContain("Unsupported");
  });
  it("taps pre-volume batched output once and restores live volume after review", async () => {
    const output = { sampleRate: 48000, play: vi.fn(), getVolume: () => 0, setVolume: vi.fn() };
    const player = new PcmBatchPlayer(output, () => "Generated playback; no hardware");
    audioArchive.startRecording(); audioArchive.setRewind(true); player.configure(true); player.setVolume(0);
    player.play(new Float32Array(1100).fill(.5), new Float32Array(1100).fill(-.5)); player.flush();
    expect(audioArchive.recordedSeconds).toBe(1100 / 48000);
    audioArchive.setReviewing(true); expect(output.setVolume).toHaveBeenLastCalledWith(0);
    player.setVolume(.7); expect(output.setVolume).toHaveBeenLastCalledWith(0);
    // The monitor follows the current volume even before the next PCM block.
    audioArchive.setReviewing(false);
    expect(output.setVolume).toHaveBeenLastCalledWith(.7);
    player.reset(); expect(audioArchive.recording).toBe(false);
    expect((await wav(audioArchive.recordingWav())).view.getInt16(44, true)).toBe(16384);
  });
});

it("keeps the PCM/WAV rate stable when the output reveals a different device rate", async () => {
    let deviceOpened = false;
    const output = { get sampleRate() { return deviceOpened ? 44_100 : 48_000; },
      play: () => { deviceOpened = true; }, setVolume: vi.fn(), getVolume: () => 1 };
    const player = new PcmBatchPlayer(output, () => "Generated 48 kHz PCM; 44.1 kHz device; not RF");
    audioArchive.startRecording(); audioArchive.setRewind(true);
    const block = new Float32Array(24_000).fill(.25);
    player.play(block, block); player.play(block, block);
    expect(player.sampleRate).toBe(48_000);
    expect(audioArchive.recording).toBe(true);
    player.finishAudio(); player.reset();
    expect(audioArchive.message).toContain("end of file");
    expect(audioArchive.recordedSeconds).toBe(1);
    expect(audioArchive.rewindSeconds).toBe(1);
    const view = new DataView(await audioArchive.recordingWav().arrayBuffer());
    expect(view.getUint32(24, true)).toBe(48_000);
    expect(view.getUint32(40, true)).toBe(48_000 * 4);
});

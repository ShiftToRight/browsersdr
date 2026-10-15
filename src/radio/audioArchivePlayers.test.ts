import { afterEach, expect, it, vi } from "vitest";
import { audioArchive } from "./audioArchive";
import { DabAudioPlayer } from "../dab/dabAudio";
import { RemoteAudio } from "../remote/remoteAudio";

function graph() {
  const gain = { gain: { value: 0 }, connect: vi.fn(), disconnect: vi.fn() };
  const context = {
    state: "running", currentTime: 0, destination: {},
    resume: vi.fn(async () => {}), close: vi.fn(async () => {}),
    createGain: () => gain,
    createBuffer: () => ({ getChannelData: () => new Float32Array(3), copyToChannel: vi.fn() }),
    createBufferSource: () => ({ connect: vi.fn(), disconnect: vi.fn(), start: vi.fn(), stop: vi.fn() }),
  };
  return { context, gain };
}
afterEach(() => { audioArchive.clearSource(); audioArchive.setRewind(false); audioArchive.discard(); vi.unstubAllGlobals(); });
it("records DAB stereo before volume, follows review volume and closes at a programme boundary", async () => {
  const { context, gain } = graph();
  const player = new DabAudioPlayer(context as unknown as AudioContext, () => "DAB test programme; not RF");
  audioArchive.startRecording(); audioArchive.setRewind(true); player.setVolume(0);
  player.play(Float32Array.of(.25, .5, 1), Float32Array.of(-.25, -.5, -1));
  audioArchive.setReviewing(true); player.setVolume(.6); expect(gain.gain.value).toBe(0);
  audioArchive.setReviewing(false); expect(gain.gain.value).toBe(.6);
  player.reset(); expect(audioArchive.recording).toBe(false); expect(audioArchive.rewindSeconds).toBe(0);
  const bytes = await audioArchive.recordingWav().arrayBuffer(), view = new DataView(bytes);
  expect(view.getUint32(24, true)).toBe(48000); expect(view.getInt16(44, true)).toBe(8192); expect(view.getInt16(46, true)).toBe(-8192);
  expect(new TextDecoder().decode(bytes)).toContain("DAB test programme"); player.dispose();
});
it("records remote mono as duplicated stereo with processed provenance and fractional-clock support", async () => {
  const { context, gain } = graph();
  vi.stubGlobal("AudioContext", class { constructor() { return context; } });
  const output = new RemoteAudio(); await output.resume(0);
  audioArchive.startRecording(); audioArchive.setRewind(true);
  output.push(Float32Array.of(.25, -.5, 1), 12000.25);
  audioArchive.setReviewing(true); output.volume(.4); expect(gain.gain.value).toBe(0);
  audioArchive.setReviewing(false); expect(gain.gain.value).toBe(.4);
  output.close(); expect(audioArchive.recording).toBe(false); expect(audioArchive.rewindSeconds).toBe(0);
  const bytes = await audioArchive.recordingWav().arrayBuffer(), view = new DataView(bytes);
  expect(view.getUint32(24, true)).toBe(12000); expect(view.getUint32(40, true)).toBe(12);
  expect(view.getInt16(44, true)).toBe(8192); expect(view.getInt16(46, true)).toBe(8192);
  expect(new TextDecoder().decode(bytes)).toContain("Processed remote receiver audio");
});

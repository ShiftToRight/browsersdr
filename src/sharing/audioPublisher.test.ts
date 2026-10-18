import { expect, it, vi, afterEach } from "vitest";
import { ShareAudioPublisher } from "./audioPublisher";
import { PcmBatchPlayer } from "../radio/pcmBatchPlayer";
import { audioCaptureTap } from "../radio/audioCaptureTap";

function graph() {
  const buffers: Float32Array[][] = [], starts: number[] = [];
  const track = { stop: vi.fn() };
  const context = { state: "running", currentTime: 1, close: vi.fn(),
    createMediaStreamDestination: () => ({ stream: { getAudioTracks: () => [track], getTracks: () => [track] }, disconnect: vi.fn() }),
    createBuffer: (_channels: number, length: number, _rate: number) => {
      const channels = [new Float32Array(length), new Float32Array(length)]; buffers.push(channels);
      return { copyToChannel: (bytes: Float32Array, index: number) => channels[index]!.set(bytes) };
    },
    createBufferSource: () => ({ buffer: undefined, onended: null, connect: vi.fn(), disconnect: vi.fn(), stop: vi.fn(), start: (t: number) => starts.push(t) }),
  };
  return { context: context as unknown as AudioContext, raw: context, buffers, starts, track };
}
afterEach(() => { audioCaptureTap.live = undefined; });
it("copies borrowed stereo before local volume without requiring archive/rewind and never owns context teardown", () => {
  const g = graph(), changed = vi.fn(), publisher = new ShareAudioPublisher(changed);
  audioCaptureTap.live = publisher;
  const output = { sampleRate: 48000, getVolume: () => 0, setVolume: vi.fn(), play: vi.fn() };
  const player = new PcmBatchPlayer(output, () => "test", g.context);
  const left = new Float32Array(960).fill(.25), right = new Float32Array(960).fill(-.5);
  player.setVolume(0); player.play(left, right); left.fill(0); right.fill(0);
  expect(g.buffers[0]![0]![0]).toBe(.25); expect(g.buffers[0]![1]![0]).toBe(-.5);
  expect(changed).toHaveBeenCalledTimes(1); expect(output.play).toHaveBeenCalledOnce();
  player.reset(); publisher.close(); publisher.close();
  expect(g.track.stop).toHaveBeenCalledOnce(); expect(g.raw.close).not.toHaveBeenCalled();
});
it("bounds burst scheduling and prevents any new data after close or while publication is disabled", () => {
  const g = graph(), publisher = new ShareAudioPublisher(vi.fn()), owner = {};
  publisher.push(owner, new Float32Array(48000), new Float32Array(48000), 48000, g.context);
  expect(publisher.drops).toBeGreaterThan(0); expect(Math.max(...g.starts)).toBeLessThan(1.3);
  const before = g.buffers.length; publisher.enabled = false;
  publisher.push(owner, new Float32Array(960), new Float32Array(960), 48000, g.context);
  expect(g.buffers).toHaveLength(before); publisher.close(); publisher.enabled = true;
  publisher.push(owner, new Float32Array(960), new Float32Array(960), 48000, g.context);
  expect(g.buffers).toHaveLength(before);
});

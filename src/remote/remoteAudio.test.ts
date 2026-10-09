import { afterEach, expect, it, vi } from "vitest";
import { RemoteAudio } from "./remoteAudio";
class Node {
  buffer?: { duration: number };
  onended: (() => void) | null = null;
  connect = vi.fn();
  disconnect = vi.fn();
  stop = vi.fn();
  start = vi.fn();
}
class Context {
  static last: Context;
  state: AudioContextState = "suspended";
  currentTime = 0;
  destination = {};
  nodes: Node[] = [];
  constructor() {
    Context.last = this;
  }
  resume = vi.fn(async () => {
    this.state = "running";
  });
  close = vi.fn(async () => {
    this.state = "closed";
  });
  createGain() {
    return { gain: { value: 0 }, connect: vi.fn(), disconnect: vi.fn() };
  }
  createBuffer(_channels: number, length: number, rate: number) {
    return {
      duration: length / rate,
      getChannelData: () => new Float32Array(length),
    };
  }
  createBufferSource() {
    const node = new Node();
    this.nodes.push(node);
    return node;
  }
}
afterEach(() => vi.unstubAllGlobals());
it("bounds scheduled audio latency, rejects oversized chunks and closes all retained nodes", async () => {
  vi.stubGlobal("AudioContext", Context);
  const audio = new RemoteAudio();
  await audio.resume(0.5);
  const context = Context.last;
  for (let i = 0; i < 20; i++) audio.push(new Float32Array(1200), 12000);
  expect(audio.drops).toBeGreaterThan(0);
  const active = context.nodes.filter((n) => !n.stop.mock.calls.length);
  const end = Math.max(
    ...active.map(
      (n) => (n.start.mock.calls[0]?.[0] as number) + n.buffer!.duration,
    ),
  );
  expect(end).toBeLessThanOrEqual(0.625);
  const count = context.nodes.length;
  audio.push(new Float32Array(12001), 12000);
  expect(context.nodes).toHaveLength(count);
  audio.close();
  expect(context.nodes.every((n) => n.stop.mock.calls.length === 1)).toBe(true);
  expect(context.close).toHaveBeenCalledOnce();
  audio.close();
  expect(context.close).toHaveBeenCalledOnce();
});
it("releases ended nodes and does not schedule while browser audio is suspended", async () => {
  vi.stubGlobal("AudioContext", Context);
  const audio = new RemoteAudio();
  await audio.resume(0.4);
  const context = Context.last;
  audio.push(Float32Array.of(1, 0, -1), 12000);
  context.nodes[0]!.onended?.();
  expect(context.nodes[0]!.disconnect).toHaveBeenCalledOnce();
  context.state = "suspended";
  audio.push(new Float32Array(1200), 12000);
  expect(context.nodes).toHaveLength(1);
  audio.close();
  expect(context.nodes[0]!.stop).not.toHaveBeenCalled();
});

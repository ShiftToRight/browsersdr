import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { KiwiClient } from "./kiwiClient";
class Socket {
  readyState = 1;
  bufferedAmount = 0;
  binaryType = "";
  sent: string[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  send(value: string) {
    this.sent.push(value);
  }
  close = vi.fn();
  emit(data: unknown) {
    this.onmessage?.({ data });
  }
}
function setup() {
  const sockets: Socket[] = [],
    urls: string[] = [];
  const audio = {
    resume: vi.fn(async () => {}),
    push: vi.fn(),
    volume: vi.fn(),
    flush: vi.fn(),
    close: vi.fn(),
    state: "running" as AudioContextState,
    drops: 0,
  };
  const client = new KiwiClient((url) => {
    urls.push(url);
    const socket = new Socket();
    sockets.push(socket);
    return socket as unknown as WebSocket;
  }, audio);
  client.connect("https://kiwi.example", "https:");
  const sound = sockets[0]!;
  sound.onopen?.();
  const ready = () => {
    sound.emit(
      "MSG badp=0 version_maj=1 version_min=800 bandwidth=30000000 freq_offset=0 audio_rate=12000 sample_rate=12000.025",
    );
    const waterfall = sockets[1]!;
    waterfall.onopen?.();
    waterfall.emit(
      "MSG badp=0 wf_fft_size=1024 zoom_max=14 zoom_cap=12 wf_setup",
    );
    return waterfall;
  };
  return { client, sound, sockets, urls, audio, ready };
}
const pcm = (seq: number) => {
  const frame = Uint8Array.of(
    83,
    78,
    68,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0x40,
    0,
    0x80,
    0,
  );
  new DataView(frame.buffer).setUint32(4, seq, true);
  return frame.buffer;
};
beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());
describe("KiwiSDR lifecycle and isolation", () => {
  it("pairs authenticated streams, receives config and keeps browser audio off until Listen", async () => {
    const { client, sound, audio, ready, urls } = setup();
    const waterfall = ready();
    expect(client.getSnapshot()).toMatchObject({
      status: "connected",
      maxZoom: 12,
      sampleRate: 12000.025,
    });
    expect(urls[0]!.split("/").slice(-2, -1)).toEqual(
      urls[1]!.split("/").slice(-3, -2),
    );
    expect(sound.sent).toContain("SET compression=0");
    expect(waterfall.sent).toContain("SET wf_comp=0");
    sound.emit(pcm(1));
    expect(audio.resume).not.toHaveBeenCalled();
    expect(audio.push).not.toHaveBeenCalled();
    await client.start(client.getSnapshot().tune!, 0.4);
    sound.emit(pcm(2));
    expect(audio.push).toHaveBeenCalledWith(
      Float32Array.of(0.5, -1),
      12000.025,
    );
    vi.advanceTimersByTime(5000);
    expect(client.getSnapshot().audioSamples).toBe(2);
    expect(sound.sent).toContain("SET keepalive");
    client.stop();
    expect(sound.close).toHaveBeenCalled();
    expect(waterfall.close).toHaveBeenCalled();
  });
  it("rejects out-of-band commands, respects zoom caps and drops queued old-range FFT rows", async () => {
    const { client, sound, ready } = setup();
    const waterfall = ready();
    await client.start(client.getSnapshot().tune!, 0.4);
    const sent = sound.sent.length;
    expect(() =>
      client.tune({ ...client.getSnapshot().tune!, frequency: 100e6 }),
    ).toThrow();
    expect(sound.sent.length).toBe(sent);
    expect(() => client.setZoom(13)).toThrow();
    client.setZoom(4);
    const receive = vi.fn();
    client.subscribeFrames(receive);
    const old = new Uint8Array(1040);
    old.set([87, 47, 70, 32]);
    old.fill(155, 16);
    waterfall.emit(old.buffer);
    expect(receive).not.toHaveBeenCalled();
    const command = waterfall.sent.at(-1)!;
    new DataView(old.buffer).setUint32(
      4,
      Number(command.split("start=")[1]),
      true,
    );
    new DataView(old.buffer).setUint32(8, 4, true);
    waterfall.emit(old.buffer);
    expect(receive).toHaveBeenCalledWith(expect.any(Float32Array));
  });
  it("flushes sequence discontinuities and rejects stereo/compressed/malformed stream data", async () => {
    const { client, sound, audio, ready } = setup();
    ready();
    await client.start(client.getSnapshot().tune!, 0.4);
    sound.emit(pcm(1));
    sound.emit(pcm(3));
    expect(audio.flush).toHaveBeenCalled();
    vi.advanceTimersByTime(5000);
    expect(client.getSnapshot().packetDiscontinuities).toBe(1);
    const bad = new Uint8Array(pcm(4));
    bad[3] = 16;
    sound.emit(bad.buffer);
    expect(client.getSnapshot().status).toBe("error");
    expect(client.getSnapshot().message).toContain("mono");
  });
  it("closes both sockets on access failure, timeout or a changed band without retry", () => {
    const { client, sound, ready } = setup();
    const waterfall = ready();
    waterfall.emit("MSG too_busy=4");
    expect(client.getSnapshot().status).toBe("error");
    expect(sound.close).toHaveBeenCalled();
    const second = setup();
    second.ready();
    second.sound.emit("MSG bandwidth=32000000");
    expect(second.client.getSnapshot().message).toContain("band changed");
    const third = setup();
    vi.advanceTimersByTime(15000);
    expect(third.client.getSnapshot().status).toBe("error");
    const fourth = setup();
    fourth.sound.emit("MSG badp=1");
    expect(fourth.sockets.length).toBe(1);
    expect(fourth.client.getSnapshot().message).toContain("access");
  });
  it("Stop during audio permission cannot restart or send late tuning; stale callbacks stay harmless", async () => {
    const { client, sound, audio, ready } = setup();
    const waterfall = ready();
    let finish!: () => void;
    audio.resume.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    const callback = sound.onmessage!,
      start = client.start(client.getSnapshot().tune!, 0.4),
      sent = sound.sent.length;
    client.stop();
    finish();
    await start;
    callback({ data: pcm(1) });
    expect(sound.sent.length).toBe(sent);
    expect(audio.push).not.toHaveBeenCalled();
    expect(waterfall.close).toHaveBeenCalled();
    expect(client.getSnapshot().status).toBe("disconnected");
  });
});

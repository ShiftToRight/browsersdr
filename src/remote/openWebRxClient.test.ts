import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { OpenWebRxClient } from "./openWebRxClient";
import { defaultTune } from "./openWebRxProtocol";
const wireConfig = {
  center_freq: 10000000,
  samp_rate: 192000,
  fft_size: 128,
  audio_compression: "none",
  fft_compression: "none",
  start_freq: 10000000,
  start_mod: "am",
  sdr_id: "radio",
  profile_id: "hf",
};
class Socket {
  readyState = 1;
  bufferedAmount = 0;
  binaryType = "";
  sent: string[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((e: { data: unknown }) => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: (() => void) | null = null;
  send(data: string) {
    this.sent.push(data);
  }
  close = vi.fn();
  emit(value: unknown) {
    this.onmessage?.({
      data:
        typeof value === "string" || value instanceof ArrayBuffer
          ? value
          : JSON.stringify(value),
    });
  }
}
function setup() {
  const socket = new Socket();
  const audio = {
    resume: vi.fn(async () => {}),
    push: vi.fn(),
    volume: vi.fn(),
    flush: vi.fn(),
    close: vi.fn(),
    state: "running" as AudioContextState,
    drops: 0,
  };
  const client = new OpenWebRxClient(
    () => socket as unknown as WebSocket,
    audio,
  );
  client.connect("https://example.org", "https:");
  socket.onopen?.();
  return {
    client,
    socket,
    audio,
    ready: () => {
      socket.emit("CLIENT DE SERVER server=openwebrx version=v1.2.126");
      socket.emit({ type: "config", value: wireConfig });
    },
  };
}
beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());
describe("remote receiver lifecycle", () => {
  it("negotiates output rates and waits for an explicit Listen gesture", async () => {
    const { client, socket, audio, ready } = setup();
    ready();
    expect(client.getSnapshot().status).toBe("connected");
    expect(audio.resume).not.toHaveBeenCalled();
    expect(socket.sent).toEqual([
      "SERVER DE CLIENT client=browsersdr type=receiver",
      JSON.stringify({
        type: "connectionproperties",
        params: { output_rate: 12000, hd_output_rate: 48000 },
      }),
    ]);
    await client.start(defaultTune(client.getSnapshot().config!), 0.4);
    expect(
      socket.sent.map((s) =>
        s.startsWith("{") ? JSON.parse(s).action : undefined,
      ),
    ).toContain("start");
    socket.emit(Uint8Array.of(2, 0, 64, 0, 128).buffer);
    expect(audio.push).toHaveBeenCalledWith(Float32Array.of(0.5, -1), 12000);
    vi.advanceTimersByTime(1000);
    expect(client.getSnapshot().audioSamples).toBe(2);
    client.stop();
    expect(socket.close).toHaveBeenCalled();
    expect(audio.close).toHaveBeenCalled();
  });
  it("ignores queued callbacks from a previous connection and cancels startup after Stop", async () => {
    const { client, socket, audio, ready } = setup();
    ready();
    let resume!: () => void;
    audio.resume.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          resume = resolve;
        }),
    );
    const late = socket.onmessage!,
      start = client.start(defaultTune(client.getSnapshot().config!), 0.5);
    client.stop();
    resume();
    await start;
    late({ data: JSON.stringify({ type: "config", value: wireConfig }) });
    expect(client.getSnapshot().status).toBe("disconnected");
    expect(socket.sent.some((s) => s.includes('"action":"start"'))).toBe(false);
    vi.advanceTimersByTime(30000);
    expect(client.getSnapshot().status).toBe("disconnected");
  });
  it("rejects invalid channels before sending any tuning command", async () => {
    const { client, socket, ready } = setup();
    ready();
    const tune = defaultTune(client.getSnapshot().config!);
    await expect(client.start({ ...tune, frequency: 1 }, 0.5)).rejects.toThrow(
      /fit inside/,
    );
    expect(socket.sent).toHaveLength(2);
    client.stop();
  });
  it("merges partial server configuration and requires actual profile acknowledgement", () => {
    const { client, socket, ready } = setup();
    ready();
    socket.emit({
      type: "profiles",
      value: [{ id: "radio|vhf", name: "VHF" }],
    });
    client.selectProfile("radio|vhf");
    expect(client.getSnapshot().pendingProfile).toBe("radio|vhf");
    expect(client.getSnapshot().config).toBeUndefined();
    socket.emit({ type: "config", value: { center_freq: 144000000 } });
    expect(client.getSnapshot().pendingProfile).toBe("radio|vhf");
    socket.emit({
      type: "config",
      value: { profile_id: "vhf", samp_rate: 2400000, start_freq: 144500000 },
    });
    expect(client.getSnapshot().pendingProfile).toBe("");
    expect(client.getSnapshot().config?.fftSize).toBe(128);
    vi.advanceTimersByTime(9000);
    expect(client.getSnapshot().status).toBe("connected");
    client.stop();
  });
  it("waits through literal VK4DL null detach metadata and publishes only the confirmed new band", async () => {
    const { client, socket, audio, ready } = setup();
    ready();
    const frames = vi.fn();
    const oldTune = client.getSnapshot().tune!;
    client.subscribeFrames(frames);
    socket.emit({
      type: "profiles",
      value: [{ id: "second|20m", name: "20m" }],
    });
    client.selectProfile("second|20m");
    socket.emit({
      type: "config",
      value: {
        center_freq: null,
        samp_rate: null,
        start_freq: null,
        start_mod: null,
        sdr_id: "radio",
        profile_id: null,
        waterfall_levels: { min: -80, max: -30 },
      },
    });
    expect(client.getSnapshot().status).toBe("connected");
    expect(client.getSnapshot().pendingProfile).toBe("second|20m");
    expect(client.getSnapshot().config).toBeUndefined();
    expect(socket.close).not.toHaveBeenCalled();
    // Old-generation frames and an identity-only acknowledgement cannot enable Listen.
    socket.emit(Uint8Array.of(1, 0).buffer);
    socket.emit({
      type: "config",
      value: { sdr_id: "second", profile_id: "20m" },
    });
    await client.start(oldTune, 0.5);
    expect(audio.resume).not.toHaveBeenCalled();
    expect(client.getSnapshot().pendingProfile).toBe("second|20m");
    expect(frames).toHaveBeenCalledTimes(1); // selection cleared the old display
    socket.emit({
      type: "config",
      value: {
        center_freq: 14175000,
        samp_rate: 384000,
        start_freq: 14200000,
        start_mod: "usb",
      },
    });
    expect(client.getSnapshot().pendingProfile).toBe("");
    expect(client.getSnapshot().config).toMatchObject({
      center: 14175000,
      rate: 384000,
      profile: "second|20m",
      fftSize: 128,
    });
    expect(client.getSnapshot().tune).toMatchObject({
      frequency: 14200000,
      mode: "usb",
    });
    expect(audio.resume).not.toHaveBeenCalled();
    await client.start(client.getSnapshot().tune!, 0.5);
    expect(client.getSnapshot().status).toBe("listening");
    client.stop();
  });
  it("keeps unconfirmed or missing band coordinates bounded by the original timeout", () => {
    const { client, socket, ready } = setup();
    ready();
    socket.emit({
      type: "profiles",
      value: [{ id: "radio|vhf", name: "VHF" }],
    });
    client.selectProfile("radio|vhf");
    socket.emit({
      type: "config",
      value: { center_freq: null, samp_rate: null, profile_id: null },
    });
    socket.emit({ type: "config", value: wireConfig }); // stale old profile
    socket.emit({ type: "config", value: { profile_id: "vhf" } });
    expect(client.getSnapshot().config).toBeUndefined();
    expect(client.getSnapshot().pendingProfile).toBe("radio|vhf");
    vi.advanceTimersByTime(8000);
    expect(client.getSnapshot().status).toBe("error");
    expect(client.getSnapshot().message).toContain("did not confirm");
    expect(socket.close).toHaveBeenCalledOnce();
  });
  it("still rejects unsolicited null band metadata and malformed numeric replacement bands", async () => {
    for (const state of ["connected", "listening", "pending"] as const) {
      const { client, socket, ready } = setup();
      ready();
      if (state === "listening")
        await client.start(client.getSnapshot().tune!, 0.5);
      if (state === "pending") {
        socket.emit({
          type: "profiles",
          value: [{ id: "radio|vhf", name: "VHF" }],
        });
        client.selectProfile("radio|vhf");
      }
      socket.emit({
        type: "config",
        value:
          state === "pending"
            ? { center_freq: 144000000, samp_rate: 0, profile_id: "vhf" }
            : { center_freq: null, samp_rate: null },
      });
      expect(client.getSnapshot().status).toBe("error");
      expect(client.getSnapshot().message).toContain("Invalid receiver band");
      expect(socket.close).toHaveBeenCalledOnce();
    }
  });
  it("fails safely on handshake, malformed data, timeouts and unconfirmed bands", () => {
    for (const failure of [
      "handshake",
      "frame",
      "timeout",
      "profile",
    ] as const) {
      const { client, socket, ready } = setup();
      if (failure === "handshake") socket.emit("CLIENT DE SERVER server=other");
      else if (failure === "timeout") vi.advanceTimersByTime(10000);
      else {
        ready();
        if (failure === "frame") socket.emit(new ArrayBuffer(1048577));
        else {
          socket.emit({
            type: "profiles",
            value: [{ id: "radio|other", name: "Other" }],
          });
          client.selectProfile("radio|other");
          vi.advanceTimersByTime(8000);
        }
      }
      expect(client.getSnapshot().status).toBe("error");
      expect(socket.close).toHaveBeenCalled();
    }
  });
  it("stops rather than silently interpreting a changed live band or audio startup failure", async () => {
    const { client, socket, ready } = setup();
    ready();
    await client.start(defaultTune(client.getSnapshot().config!), 0.4);
    socket.emit({ type: "config", value: { center_freq: 20000000 } });
    expect(client.getSnapshot().status).toBe("error");
    const second = setup();
    second.ready();
    second.audio.resume.mockRejectedValue(new Error("Audio blocked"));
    await second.client.start(
      defaultTune(second.client.getSnapshot().config!),
      0.4,
    );
    expect(second.client.getSnapshot().message).toBe("Audio blocked");
  });
});

it("preserves one compressed mono stream across standard and HD audio mode transitions", async () => {
  const { client, socket, audio, ready } = setup();
  ready();
  socket.emit({ type: "config", value: { audio_compression: "adpcm" } });
  await client.start(defaultTune(client.getSnapshot().config!), 0.4);
  socket.emit(Uint8Array.of(2, 83, 89, 78, 67, 0, 0, 232, 3, 0x77).buffer);
  expect(audio.push).toHaveBeenLastCalledWith(
    Float32Array.of(1000 / 32768, 1030 / 32768),
    12000,
  );
  client.tune({ ...defaultTune(client.getSnapshot().config!, "wfm") });
  socket.emit(Uint8Array.of(4, 0x88).buffer);
  expect(audio.push).toHaveBeenLastCalledWith(
    Float32Array.of(1026 / 32768, 1023 / 32768),
    48000,
  );
  client.stop();
});

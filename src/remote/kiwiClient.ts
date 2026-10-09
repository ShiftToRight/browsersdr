import { defaultTune, type RemoteTune } from "./openWebRxProtocol";
import type { RemoteSnapshot } from "./openWebRxClient";
import { RemoteAudio } from "./remoteAudio";
import {
  KIWI_BINS,
  KIWI_MODES,
  kiwiAudio,
  kiwiTag,
  kiwiTune,
  kiwiUrls,
  kiwiWaterfall,
  kiwiWindow,
} from "./kiwiProtocol";

export interface KiwiSnapshot extends RemoteSnapshot {
  zoom: number;
  maxZoom: number;
  sampleRate: number;
  packetDiscontinuities: number;
}
type Stream = "sound" | "waterfall";
type AudioSink = Pick<
  RemoteAudio,
  "resume" | "push" | "volume" | "flush" | "close" | "state" | "drops"
>;
const initial = (): KiwiSnapshot => ({
  status: "disconnected",
  message: "Enter a KiwiSDR receiver address to connect.",
  website: "",
  version: "",
  title: "",
  profiles: [],
  modes: [...KIWI_MODES],
  pendingProfile: "",
  fftFrames: 0,
  audioSamples: 0,
  audioState: "closed",
  audioDrops: 0,
  zoom: 0,
  maxZoom: 14,
  sampleRate: 0,
  packetDiscontinuities: 0,
});

export class KiwiClient {
  private snapshot = initial();
  private listeners = new Set<() => void>();
  private frames = new Set<(frame: Float32Array | undefined) => void>();
  private sockets: Partial<Record<Stream, WebSocket>> = {};
  private generation = 0;
  private timer?: ReturnType<typeof setTimeout>;
  private stats?: ReturnType<typeof setInterval>;
  private bandwidth = 0;
  private offset = 0;
  private audioRate = 0;
  private soundReady = false;
  private waterfallReady = false;
  private starting = false;
  private wanted?: ReturnType<typeof kiwiWindow>;
  private fftCount = 0;
  private audioCount = 0;
  private lastFrame = 0;
  private sequence?: number;
  private gaps = 0;
  private major?: number;
  private minor?: number;
  private endpoints?: ReturnType<typeof kiwiUrls>;
  constructor(
    private factory: (url: string) => WebSocket = (url) => new WebSocket(url),
    private audio: AudioSink = new RemoteAudio(),
  ) {}
  getSnapshot = () => this.snapshot;
  subscribe = (fn: () => void) => {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  };
  subscribeFrames = (fn: (frame: Float32Array | undefined) => void) => {
    this.frames.add(fn);
    return () => {
      this.frames.delete(fn);
    };
  };
  private publish(patch: Partial<KiwiSnapshot>) {
    this.snapshot = { ...this.snapshot, ...patch };
    for (const fn of this.listeners) fn();
  }
  private clearFrames() {
    for (const fn of this.frames) fn(undefined);
  }
  private release() {
    this.generation++;
    this.starting = false;
    clearTimeout(this.timer);
    clearInterval(this.stats);
    for (const socket of Object.values(this.sockets)) {
      socket.onopen = socket.onmessage = socket.onerror = socket.onclose = null;
      socket.close();
    }
    this.sockets = {};
    this.audio.close();
    this.clearFrames();
  }
  stop = () => {
    this.release();
    this.publish({
      status: "disconnected",
      message: "Stopped. Connect again when ready.",
      audioState: "closed",
    });
  };
  private fail(message: string) {
    this.release();
    this.publish({ status: "error", message, audioState: "closed" });
  }
  connect(input: string, pageProtocol?: string) {
    let endpoints: ReturnType<typeof kiwiUrls>;
    try {
      endpoints = kiwiUrls(input, Date.now(), pageProtocol);
    } catch (error) {
      this.publish({ message: (error as Error).message });
      return;
    }
    this.release();
    this.endpoints = endpoints;
    this.snapshot = initial();
    this.bandwidth = this.offset = this.audioRate = 0;
    this.soundReady = this.waterfallReady = false;
    this.wanted = undefined;
    this.sequence = undefined;
    this.fftCount = this.audioCount = this.gaps = 0;
    this.major = this.minor = undefined;
    this.publish({
      status: "connecting",
      website: endpoints.website,
      message: "Connecting to KiwiSDR…",
    });
    this.open("sound");
    if (this.snapshot.status === "error") return;
    this.timer = setTimeout(
      () =>
        this.fail(
          "KiwiSDR did not provide a supported audio and waterfall configuration. Open its website to check access.",
        ),
      15000,
    );
    this.stats = setInterval(() => {
      try {
        for (const stream of ["sound", "waterfall"] as const)
          if (this.sockets[stream]?.readyState === 1)
            this.send(stream, "SET keepalive");
      } catch (error) {
        this.fail((error as Error).message);
        return;
      }
      this.publish({
        fftFrames: this.fftCount,
        audioSamples: this.audioCount,
        audioState: this.audio.state,
        audioDrops: this.audio.drops,
        packetDiscontinuities: this.gaps,
        ...(this.snapshot.status === "listening" &&
        Date.now() - this.lastFrame > 10000
          ? {
              message:
                "Waiting for KiwiSDR audio. Stop and reconnect if it does not recover.",
            }
          : {}),
      });
    }, 5000);
  }
  private send(stream: Stream, command: string) {
    const socket = this.sockets[stream];
    if (!socket || socket.readyState !== 1 || socket.bufferedAmount > 65536)
      throw new Error("KiwiSDR connection is not ready. Stop and reconnect.");
    socket.send(command);
  }
  private open(stream: Stream) {
    const generation = this.generation;
    let socket: WebSocket;
    try {
      socket = this.factory(this.endpoints![stream]);
    } catch {
      this.fail(
        "KiwiSDR connection could not be opened. Check the address or open its website.",
      );
      return;
    }
    this.sockets[stream] = socket;
    socket.binaryType = "arraybuffer";
    socket.onopen = () => {
      if (generation === this.generation) {
        try {
          this.send(stream, "SET auth t=kiwi p=");
        } catch (error) {
          this.fail((error as Error).message);
        }
      }
    };
    socket.onclose = socket.onerror = () => {
      if (generation === this.generation)
        this.fail(
          "KiwiSDR disconnected or could not be reached. Check receiver availability, HTTPS and access, then Connect again.",
        );
    };
    socket.onmessage = (event) => {
      if (generation !== this.generation) return;
      try {
        this.message(stream, event.data);
      } catch (error) {
        this.fail((error as Error).message);
      }
    };
  }
  private number(value: string, min: number, max: number, name: string) {
    const result = Number(value);
    if (!value || !Number.isFinite(result) || result < min || result > max)
      throw new Error(`Invalid KiwiSDR ${name}.`);
    return result;
  }
  private message(stream: Stream, data: unknown) {
    let message: string | undefined;
    if (typeof data === "string") message = data;
    else if (data instanceof ArrayBuffer && kiwiTag(data) === "MSG")
      message = new TextDecoder().decode(data);
    if (message !== undefined) {
      if (message.length > 131072 || !message.startsWith("MSG "))
        throw new Error("Unsupported KiwiSDR message.");
      for (const item of message.slice(4).split(" ")) {
        const equal = item.indexOf("="),
          name = equal < 0 ? item : item.slice(0, equal),
          value = equal < 0 ? "" : item.slice(equal + 1);
        if (name === "badp" && value !== "0")
          throw new Error(
            "This KiwiSDR requires access approval or has no public channels available. Open its website.",
          );
        if (
          [
            "too_busy",
            "down",
            "inactivity_timeout",
            "ip_limit",
            "kiwi_disabled",
            "redirect",
            "require_id",
            "no_wf",
          ].includes(name)
        )
          throw new Error(
            "This KiwiSDR is busy, restricted or unavailable for this connection. Open its website for access.",
          );
        if (
          name === "badp" &&
          value === "0" &&
          stream === "sound" &&
          !this.sockets.waterfall
        )
          this.open("waterfall");
        if (name === "version_maj")
          this.major = this.number(value, 1, 100, "version");
        if (name === "version_min")
          this.minor = this.number(value, 0, 10000, "version");
        if (name === "bandwidth") {
          const bandwidth = this.number(value, 1e6, 100e6, "bandwidth");
          if (this.soundReady && bandwidth !== this.bandwidth)
            throw new Error("KiwiSDR band changed. Stop and reconnect.");
          this.bandwidth = bandwidth;
        }
        if (name === "freq_offset") {
          const offset =
            this.number(value, -100e6, 100e6, "frequency offset") * 1000;
          if (this.soundReady && offset !== this.offset)
            throw new Error(
              "KiwiSDR frequency offset changed. Stop and reconnect.",
            );
          this.offset = offset;
        }
        if (name === "audio_rate" && stream === "sound") {
          this.audioRate = this.number(value, 8000, 24000, "audio rate");
          this.send("sound", "SET compression=0");
          this.send(
            "sound",
            `SET AR OK in=${Math.round(this.audioRate)} out=48000`,
          );
        }
        if (name === "sample_rate" && stream === "sound") {
          const rate = this.number(value, 8000, 24000, "sample rate");
          if (this.soundReady && rate !== this.snapshot.sampleRate)
            throw new Error("KiwiSDR audio rate changed. Stop and reconnect.");
          this.publish({ sampleRate: rate });
        }
        if (name === "wf_fft_size" && value !== "1024")
          throw new Error(
            "Unsupported KiwiSDR waterfall size. Open its website.",
          );
        if (name === "zoom_max" || name === "zoom_cap")
          this.publish({
            maxZoom: Math.min(
              this.snapshot.maxZoom,
              Math.floor(this.number(value, 0, 14, "zoom limit")),
            ),
          });
        if (name === "wf_setup" && stream === "waterfall")
          this.waterfallReady = true;
        // No operator HTML, DX database, GPS, credentials or arbitrary server configuration is retained.
      }
      this.ready();
      return;
    }
    if (!(data instanceof ArrayBuffer))
      throw new Error("Unsupported KiwiSDR frame.");
    const tag = kiwiTag(data);
    if (tag === "SND" && stream === "sound") {
      if (this.snapshot.status !== "listening") return;
      const frame = kiwiAudio(data);
      if (frame.samples.length > this.snapshot.sampleRate / 2)
        throw new Error("KiwiSDR audio frame exceeds the playback bound.");
      if (
        frame.restart ||
        (this.sequence !== undefined &&
          frame.sequence !== (this.sequence + 1) >>> 0)
      ) {
        this.audio.flush();
        if (!frame.restart) this.gaps++;
      }
      this.sequence = frame.sequence;
      this.audioCount += frame.samples.length;
      this.lastFrame = Date.now();
      this.audio.push(frame.samples, this.snapshot.sampleRate);
    } else if (tag === "W/F" && stream === "waterfall" && this.wanted) {
      const frame = kiwiWaterfall(
        data,
        this.bandwidth,
        this.offset,
        this.snapshot.maxZoom,
      );
      if (
        frame.noSync ||
        frame.start !== this.wanted.start ||
        frame.zoom !== this.wanted.zoom
      )
        return;
      this.fftCount++;
      for (const fn of this.frames) fn(frame.bins);
    }
  }
  private ready() {
    if (
      !this.soundReady &&
      this.bandwidth &&
      this.snapshot.sampleRate &&
      this.audioRate &&
      this.major !== undefined &&
      this.minor !== undefined
    ) {
      if (this.major < 1 || (this.major === 1 && this.minor < 329))
        throw new Error(
          "KiwiSDR 1.329 or later is required. Open its website instead.",
        );
      const frequency = this.offset + Math.min(7100000, this.bandwidth / 2);
      const config = {
        center: this.offset + this.bandwidth / 2,
        rate: this.bandwidth,
        fftSize: KIWI_BINS,
        audioCompression: "none" as const,
        fftCompression: "none" as const,
        startFrequency: frequency,
        startMode: "usb" as const,
        profile: "",
        floor: -130,
        ceiling: -30,
      };
      const tune = defaultTune(config);
      this.send("sound", "SERVER DE CLIENT BrowserSDR SND");
      this.send("sound", "SET ident_user=BrowserSDR");
      this.send(
        "sound",
        "SET agc=1 hang=0 thresh=-100 slope=6 decay=1000 manGain=50",
      );
      this.send("sound", "SET squelch=0 param=0");
      this.send(
        "sound",
        kiwiTune(tune, this.bandwidth, this.offset, this.snapshot.sampleRate),
      );
      this.soundReady = true;
      this.publish({ config, tune, version: `${this.major}.${this.minor}` });
    }
    if (
      this.soundReady &&
      this.waterfallReady &&
      this.snapshot.status === "connecting"
    ) {
      this.send("waterfall", "SERVER DE CLIENT BrowserSDR W/F");
      this.send("waterfall", "SET wf_comp=0");
      this.send("waterfall", "SET send_dB=1");
      this.setZoom(0);
      this.send("waterfall", "SET maxdb=-30 mindb=-130");
      this.send("waterfall", "SET wf_speed=2");
      clearTimeout(this.timer);
      this.publish({
        status: "connected",
        message:
          "Connected · receiver channel reserved. Press Listen to enable browser audio.",
      });
    }
  }
  setZoom(zoom: number) {
    if (
      !this.soundReady ||
      !this.waterfallReady ||
      !this.snapshot.tune ||
      !Number.isInteger(zoom) ||
      zoom < 0 ||
      zoom > this.snapshot.maxZoom
    )
      throw new Error("Choose an available KiwiSDR zoom level.");
    this.wanted = kiwiWindow(
      this.snapshot.tune.frequency,
      zoom,
      this.bandwidth,
      this.offset,
    );
    this.send("waterfall", `SET zoom=${zoom} start=${this.wanted.start}`);
    this.clearFrames();
    this.publish({
      zoom,
      config: {
        ...this.snapshot.config!,
        center: this.wanted.center,
        rate: this.wanted.span,
      },
    });
  }
  selectProfile() {
    throw new Error(
      "KiwiSDR uses waterfall zoom instead of receiver profiles.",
    );
  }
  async start(tune: RemoteTune, volume: number) {
    if (this.snapshot.status !== "connected" || this.starting) return;
    const command = kiwiTune(
        tune,
        this.bandwidth,
        this.offset,
        this.snapshot.sampleRate,
      ),
      generation = this.generation;
    this.starting = true;
    try {
      await this.audio.resume(volume);
      if (generation !== this.generation) return;
      this.send("sound", command);
      this.sequence = undefined;
      this.lastFrame = Date.now();
      this.publish({
        status: "listening",
        tune,
        audioState: this.audio.state,
        message: "Listening · channel tuning requested.",
      });
      this.setZoom(this.snapshot.zoom);
    } catch (error) {
      if (generation === this.generation) this.fail((error as Error).message);
      throw error;
    } finally {
      if (generation === this.generation) this.starting = false;
    }
  }
  tune(tune: RemoteTune) {
    if (this.snapshot.status !== "listening")
      throw new Error("Press Listen before tuning.");
    this.send(
      "sound",
      kiwiTune(tune, this.bandwidth, this.offset, this.snapshot.sampleRate),
    );
    this.audio.flush();
    this.sequence = undefined;
    this.publish({ tune, message: "Listening · channel tuning requested." });
    this.setZoom(this.snapshot.zoom);
  }
  volume(value: number) {
    this.audio.volume(value);
  }
  async resume(volume: number) {
    const generation = this.generation;
    if (this.snapshot.status !== "listening") return;
    await this.audio.resume(volume);
    if (generation === this.generation)
      this.publish({ audioState: this.audio.state });
  }
}

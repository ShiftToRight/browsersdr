import {
  audioFrame,
  configFrom,
  defaultTune,
  fftFrame,
  ImaDecoder,
  object,
  remoteMode,
  receiverUrl,
  text,
  tuneMessage,
  type RemoteConfig,
  type RemoteMode,
  type RemoteTune,
} from "./openWebRxProtocol";
import { RemoteAudio } from "./remoteAudio";
export interface RemoteSnapshot {
  status: "disconnected" | "connecting" | "connected" | "listening" | "error";
  message: string;
  website: string;
  version: string;
  title: string;
  config?: RemoteConfig;
  tune?: RemoteTune;
  profiles: { id: string; name: string }[];
  modes: RemoteMode[];
  pendingProfile: string;
  fftFrames: number;
  audioSamples: number;
  audioState: string;
  audioDrops: number;
}
const initial = (): RemoteSnapshot => ({
  status: "disconnected",
  message: "Enter an OpenWebRX receiver address to connect.",
  website: "",
  version: "",
  title: "",
  profiles: [],
  modes: [],
  pendingProfile: "",
  fftFrames: 0,
  audioSamples: 0,
  audioState: "closed",
  audioDrops: 0,
});
type AudioSink = Pick<
  RemoteAudio,
  "resume" | "push" | "volume" | "flush" | "close" | "state" | "drops"
>;
const bandParams = [
  "center_freq",
  "samp_rate",
  "start_freq",
  "start_offset_freq",
  "start_mod",
  "profile_id",
] as const;
export class OpenWebRxClient {
  private snapshot = initial();
  private listeners = new Set<() => void>();
  private frames = new Set<(frame: Float32Array | undefined) => void>();
  private socket?: WebSocket;
  private generation = 0;
  private hello = false;
  private params: Record<string, unknown> = {};
  private timer?: ReturnType<typeof setTimeout>;
  private stats?: ReturnType<typeof setInterval>;
  private decoder = new ImaDecoder();
  private fftCount = 0;
  private audioCount = 0;
  private lastFrame = 0;
  private starting = false;
  constructor(
    private factory: (url: string) => WebSocket = (url) => new WebSocket(url),
    private audio: AudioSink = new RemoteAudio(),
  ) {}
  getSnapshot = () => this.snapshot;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  subscribeFrames = (listener: (frame: Float32Array | undefined) => void) => {
    this.frames.add(listener);
    return () => {
      this.frames.delete(listener);
    };
  };
  private publish(patch: Partial<RemoteSnapshot>) {
    this.snapshot = { ...this.snapshot, ...patch };
    for (const listener of this.listeners) listener();
  }
  private resetFrames() {
    for (const listener of this.frames) listener(undefined);
  }
  private release() {
    this.generation++;
    this.starting = false;
    clearTimeout(this.timer);
    clearInterval(this.stats);
    this.timer = undefined;
    this.stats = undefined;
    const socket = this.socket;
    this.socket = undefined;
    if (socket) {
      socket.onopen = null;
      socket.onmessage = null;
      socket.onclose = null;
      socket.onerror = null;
      socket.close();
    }
    this.audio.close();
    this.resetFrames();
  }
  stop = () => {
    const wasConnected = this.snapshot.status !== "disconnected";
    this.release();
    this.publish({
      status: "disconnected",
      message: wasConnected
        ? "Stopped. Connect again when ready."
        : this.snapshot.message,
      pendingProfile: "",
      audioState: "closed",
    });
  };
  private fail(message: string) {
    this.release();
    this.publish({
      status: "error",
      message,
      pendingProfile: "",
      audioState: "closed",
    });
  }
  connect(input: string, pageProtocol?: string) {
    let endpoint: ReturnType<typeof receiverUrl>;
    try {
      endpoint = receiverUrl(input, pageProtocol);
    } catch (error) {
      this.publish({ message: (error as Error).message });
      return;
    }
    this.release();
    this.snapshot = initial();
    this.hello = false;
    this.params = {};
    this.decoder = new ImaDecoder();
    this.fftCount = 0;
    this.audioCount = 0;
    this.lastFrame = 0;
    this.publish({
      status: "connecting",
      website: endpoint.website,
      message: "Connecting to receiver…",
    });
    const generation = this.generation;
    let socket: WebSocket;
    try {
      socket = this.factory(endpoint.socket);
    } catch {
      this.fail(
        "Connection could not be opened. Check the address or open the receiver website.",
      );
      return;
    }
    this.socket = socket;
    socket.binaryType = "arraybuffer";
    socket.onopen = () => {
      if (generation === this.generation) {
        socket.send("SERVER DE CLIENT client=browsersdr type=receiver");
        this.send({
          type: "connectionproperties",
          params: { output_rate: 12000, hd_output_rate: 48000 },
        });
      }
    };
    socket.onclose = () => {
      if (generation === this.generation)
        this.fail(
          "Receiver disconnected. It may be busy or offline. Connect again or open its website.",
        );
    };
    socket.onerror = () => {
      if (generation === this.generation)
        this.fail(
          "Connection failed. Check HTTPS, receiver access and availability, or open its website.",
        );
    };
    socket.onmessage = (event) => {
      if (generation !== this.generation) return;
      try {
        this.message(event.data);
      } catch (error) {
        this.fail((error as Error).message);
      }
    };
    this.timer = setTimeout(
      () =>
        this.fail(
          "Receiver did not provide a supported configuration. Open its website to check access.",
        ),
      10000,
    );
    this.stats = setInterval(() => {
      const stalled =
        this.snapshot.status === "listening" &&
        Date.now() - this.lastFrame > 8000;
      this.publish({
        fftFrames: this.fftCount,
        audioSamples: this.audioCount,
        audioState: this.audio.state,
        audioDrops: this.audio.drops,
        ...(stalled
          ? {
              message:
                "Waiting for the receiver stream. Stop and reconnect if it does not recover.",
            }
          : {}),
      });
    }, 1000);
  }
  private send(value: unknown) {
    if (
      !this.socket ||
      this.socket.readyState !== 1 ||
      this.socket.bufferedAmount > 65536
    )
      throw new Error("Receiver connection is not ready. Stop and reconnect.");
    this.socket.send(JSON.stringify(value));
  }
  async start(tune: RemoteTune, volume: number) {
    const config = this.snapshot.config;
    if (
      !config ||
      this.snapshot.status !== "connected" ||
      this.snapshot.pendingProfile ||
      this.starting
    )
      return;
    const request = this.validateTune(tune);
    this.starting = true;
    const generation = this.generation;
    try {
      // Called synchronously from the Listen gesture, before any network work.
      await this.audio.resume(volume);
      if (generation !== this.generation) return;
      this.send(request);
      this.send({ type: "dspcontrol", action: "start" });
      this.lastFrame = Date.now();
      this.publish({
        status: "listening",
        tune,
        audioState: this.audio.state,
        message:
          "Listening · tuning requested; the server does not acknowledge individual tuning changes.",
      });
    } catch (error) {
      if (generation === this.generation) this.fail((error as Error).message);
    } finally {
      if (generation === this.generation) this.starting = false;
    }
  }
  tune(tune: RemoteTune) {
    if (this.snapshot.status !== "listening" || !this.snapshot.config)
      throw new Error("Start listening before applying a channel change.");
    this.send(this.validateTune(tune));
    this.audio.flush();
    this.publish({
      tune,
      message:
        "Channel change requested · no server acknowledgement is available.",
    });
  }
  volume(value: number) {
    this.audio.volume(value);
  }
  validateTune(tune: RemoteTune) {
    if (!this.snapshot.config)
      throw new Error("Connect to review this channel.");
    if (this.snapshot.modes.length && !this.snapshot.modes.includes(tune.mode))
      throw new Error(
        "This receiver does not advertise the saved mode. Choose a supported mode.",
      );
    return tuneMessage(this.snapshot.config, tune);
  }
  async resume(volume: number) {
    if (this.snapshot.status === "listening") {
      const generation = this.generation;
      await this.audio.resume(volume);
      if (generation === this.generation)
        this.publish({ audioState: this.audio.state });
    }
  }
  selectProfile(id: string) {
    if (
      this.snapshot.status !== "connected" ||
      this.snapshot.pendingProfile ||
      !this.snapshot.profiles.some((p) => p.id === id)
    )
      return;
    this.send({ type: "selectprofile", params: { profile: id } });
    // A new band must supply its own RF coordinates. Keep connection-wide
    // encoding/FFT settings, but never combine the new profile with old tuning.
    for (const key of bandParams) delete this.params[key];
    this.decoder = new ImaDecoder();
    this.resetFrames();
    this.publish({
      pendingProfile: id,
      config: undefined,
      tune: undefined,
      message: "Waiting for receiver band configuration…",
    });
    clearTimeout(this.timer);
    this.timer = setTimeout(
      () =>
        this.fail(
          "The receiver did not confirm the selected band. Open its website to check availability.",
        ),
      8000,
    );
  }
  private message(data: unknown) {
    if (typeof data === "string") {
      if (data.length > 131072)
        throw new Error("Receiver message exceeds the supported size.");
      if (data.startsWith("CLIENT DE SERVER")) {
        if (!/\bserver=openwebrx\b/.test(data))
          throw new Error("This is not a supported OpenWebRX receiver.");
        this.hello = true;
        this.publish({ version: text(data.match(/\bversion=(\S+)/)?.[1]) });
        return;
      }
      if (!this.hello) throw new Error("Unexpected receiver handshake.");
      const message = object(JSON.parse(data));
      if (message.type === "config") {
        const old = this.snapshot.config;
        const incoming = object(message.value);
        const pending = this.snapshot.pendingProfile;
        const incomingSdr = text(incoming.sdr_id);
        const knownSdr = incomingSdr || text(this.params.sdr_id);
        // A late old-profile reply must not seed the replacement's coordinates.
        if (
          pending &&
          ((incomingSdr && !pending.startsWith(`${incomingSdr}|`)) ||
            (typeof incoming.profile_id === "string" &&
              knownSdr &&
              pending.startsWith(`${knownSdr}|`) &&
              pending !== `${knownSdr}|${text(incoming.profile_id)}`))
        )
          return;
        for (const key of [
          "center_freq",
          "samp_rate",
          "fft_size",
          "audio_compression",
          "fft_compression",
          "start_freq",
          "start_offset_freq",
          "start_mod",
          "sdr_id",
          "profile_id",
          "waterfall_levels",
        ]) {
          if (Object.hasOwn(incoming, key)) {
            // OpenWebRX sends null band properties while detaching the old
            // profile. Only an explicit, bounded profile switch accepts this
            // invalidation; ordinary malformed/live configs still fail closed.
            if (
              this.snapshot.pendingProfile &&
              incoming[key] === null &&
              (bandParams.some((field) => field === key) || key === "sdr_id")
            )
              delete this.params[key];
            else this.params[key] = incoming[key];
          }
        }
        const config = configFrom(this.params);
        if (!config) return;
        if (pending && pending !== config.profile) return;
        const changed =
          old &&
          (old.center !== config.center ||
            old.rate !== config.rate ||
            old.profile !== config.profile ||
            old.fftSize !== config.fftSize ||
            old.audioCompression !== config.audioCompression ||
            old.fftCompression !== config.fftCompression);
        if (changed) {
          if (this.snapshot.status === "listening") {
            this.fail(
              "The receiver band changed during listening. Reconnect to use the new band.",
            );
            return;
          }
          this.resetFrames();
          this.decoder = new ImaDecoder();
        }
        if (!pending || pending === config.profile) clearTimeout(this.timer);
        this.publish({
          config,
          ...(!old || changed ? { tune: defaultTune(config) } : {}),
          ...(this.snapshot.status === "connecting"
            ? {
                status: "connected",
                message: "Connected · choose a channel, then Listen.",
              }
            : {}),
          ...(pending === config.profile
            ? {
                pendingProfile: "",
                message: "Band confirmed · ready to listen.",
              }
            : {}),
        });
      } else if (message.type === "profiles" && Array.isArray(message.value)) {
        this.publish({
          profiles: message.value
            .slice(0, 128)
            .map((p) => ({
              id: text(object(p).id),
              name: text(object(p).name),
            }))
            .filter((p) => p.id && p.name),
        });
      } else if (message.type === "modes" && Array.isArray(message.value)) {
        this.publish({
          modes: [
            ...new Set(
              message.value
                .map((p) => remoteMode(object(p).modulation))
                .filter((m): m is RemoteMode => Boolean(m)),
            ),
          ],
        });
      } else if (message.type === "receiver_details") {
        this.publish({ title: text(object(message.value).receiver_name) });
      } else if (
        ["sdr_error", "demodulator_error", "backoff"].includes(
          String(message.type),
        )
      ) {
        this.fail(
          `Receiver is unavailable: ${text(message.value) || text(object(message.value).message) || "access or capacity limit"}. Open its website for details.`,
        );
      }
      return;
    }
    if (
      !(data instanceof ArrayBuffer) ||
      data.byteLength < 2 ||
      data.byteLength > 1048576
    )
      throw new Error("Invalid or oversized receiver frame.");
    const config = this.snapshot.config;
    if (!config || !this.hello || this.snapshot.pendingProfile) return;
    const kind = new Uint8Array(data)[0];
    if (kind === 1) {
      const frame = fftFrame(data, config);
      this.fftCount++;
      this.lastFrame = Date.now();
      for (const listener of this.frames) listener(frame);
    } else if (
      (kind === 2 || kind === 4) &&
      this.snapshot.status === "listening"
    ) {
      const samples = audioFrame(data, config.audioCompression, this.decoder);
      this.audioCount += samples.length;
      this.lastFrame = Date.now();
      this.audio.push(samples, kind === 2 ? 12000 : 48000);
    }
  }
}

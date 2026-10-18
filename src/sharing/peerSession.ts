import { audioCaptureTap } from "../radio/audioCaptureTap";
import type { ReceiverController } from "../radio/receiverController";
import type { AnalysisPipeline } from "../dsp/analysisPipeline";
import type { SpectrumFrame } from "../radio/types";
import { ShareAudioPublisher } from "./audioPublisher";
import { createRoom, waitForAnswer, joinRoom, sendAnswer, leaveRoom } from "./roomClient";
import { decodeSpectrum, encodeSpectrum, newPeerId, parseSignal, parseState, sharedState, SHARE_SCHEMA, stereoDescription,
  validPeerId, type SharedState } from "./protocol";

export interface PeerStats { status: string; frames: number; skipped: number; audioSeconds: number; audioPackets: number; audioBytes: number; jitterMs: number; roundTripMs: number; spectrumFps: number; }
export const initialPeerStats = (): PeerStats => ({ status: "Not connected", frames: 0, skipped: 0, audioSeconds: 0, audioPackets: 0, audioBytes: 0, jitterMs: 0, roundTripMs: 0, spectrumFps: 0 });
const describe = (pc: RTCPeerConnection, id: string) => JSON.stringify({ schema: SHARE_SCHEMA, id, description: pc.localDescription?.toJSON() });
const channelName = (id: string) => `browsersdr-peer-${id}`;

/** Gathered-candidate exchange for a local spike. Never consults public STUN/TURN. */
async function localDescription(pc: RTCPeerConnection, description: RTCSessionDescriptionInit): Promise<void> {
  await pc.setLocalDescription(stereoDescription(description));
  if (pc.iceGatheringState === "complete") return;
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => { cleanup(); reject(new Error("Local network discovery timed out. Stop and try again.")); }, 5000);
    const check = () => {
      if (pc.signalingState === "closed") { cleanup(); reject(new Error("Connection closed.")); }
      else if (pc.iceGatheringState === "complete") { cleanup(); resolve(); }
    };
    const cleanup = () => { clearTimeout(timer); pc.removeEventListener("icegatheringstatechange", check); pc.removeEventListener("signalingstatechange", check); };
    pc.addEventListener("icegatheringstatechange", check); pc.addEventListener("signalingstatechange", check); check();
  });
}

class PeerBase {
  readonly pc = new RTCPeerConnection({ iceServers: [] });
  protected channel?: BroadcastChannel;
  protected stats = initialPeerStats();
  protected closed = false;
  protected interval?: ReturnType<typeof setInterval>;
  protected deadline?: ReturnType<typeof setTimeout>;
  protected readonly roomAbort = new AbortController();
  protected roomToken?: string;
  private previousFrames = 0;
  private previousTime = performance.now();
  constructor(protected readonly changed: (stats: PeerStats) => void, protected readonly ended: (reason: string) => void) {
    this.pc.onconnectionstatechange = () => {
      if (this.closed) return;
      const state = this.pc.connectionState;
      this.stats.status = state === "connected" ? "Connected" : state === "connecting" ? "Connecting" : state;
      this.publish();
      if (state === "connected") { clearTimeout(this.deadline); this.deadline = undefined; }
      if (state === "failed" || state === "disconnected") this.end("Peer connection lost. Join a new session to reconnect.");
    };
    this.interval = setInterval(() => void this.sampleStats(), 1000);
  }
  protected publish(): void { if (!this.closed) this.changed({ ...this.stats }); }
  protected timeout(): void { this.deadline = setTimeout(() => this.end("Connection timed out. This local prototype has no internet relay."), 30_000); }
  protected async sampleStats(): Promise<void> {
    if (this.closed) return;
    try {
      const reports = await this.pc.getStats();
      if (this.closed) return;
      const now = performance.now();
      this.stats.spectrumFps = (this.stats.frames - this.previousFrames) * 1000 / Math.max(1, now - this.previousTime);
      this.previousFrames = this.stats.frames; this.previousTime = now;
      reports.forEach(report => {
        if (report.type === "inbound-rtp" && report.kind === "audio") {
          this.stats.audioPackets = report.packetsReceived ?? 0; this.stats.audioBytes = report.bytesReceived ?? 0;
          this.stats.jitterMs = (report.jitter ?? 0) * 1000;
        }
        if (report.type === "candidate-pair" && report.state === "succeeded" && report.nominated) this.stats.roundTripMs = (report.currentRoundTripTime ?? 0) * 1000;
      });
      this.publish();
    } catch { /* Closing a connection can invalidate a pending stats read. */ }
  }
  protected end(reason: string): void { if (!this.closed) { this.close(); this.ended(reason); } }
  close(): void {
    if (this.closed) return;
    this.closed = true; clearInterval(this.interval); clearTimeout(this.deadline);
    this.roomAbort.abort(); if (this.roomToken) leaveRoom(this.roomToken);
    this.channel?.close(); this.pc.onconnectionstatechange = null; this.pc.close();
  }
}

export class ShareHost extends PeerBase {
  readonly id = newPeerId();
  private readonly stateChannel = this.pc.createDataChannel("state");
  private readonly spectrumChannel = this.pc.createDataChannel("spectrum", { ordered: false, maxRetransmits: 0 });
  readonly audio: ShareAudioPublisher;
  offer = "";
  private guestId?: string;
  private answering = false;
  private lastFrame = -Infinity;
  private state: SharedState;
  private unsubscribeState: () => void;
  private unsubscribeFrames: () => void;
  private gaps = 0;
  private missingSamples = 0;
  constructor(controller: ReceiverController, analysis: AnalysisPipeline, changed: (stats: PeerStats) => void, ended: (reason: string) => void) {
    super(changed, ended);
    if (controller.getSnapshot().lifecycle !== "running") { super.close(); throw new Error("Start the receiver before sharing."); }
    if (audioCaptureTap.live) { super.close(); throw new Error("A live publisher is already active."); }
    const transceiver = this.pc.addTransceiver("audio", { direction: "sendonly" });
    this.audio = new ShareAudioPublisher(track => {
      void transceiver.sender.replaceTrack(track).catch(() => this.end("The audio track could not be published. Stop and try again."));
    });
    audioCaptureTap.live = this.audio;
    this.state = sharedState(controller.getSnapshot());
    this.stateChannel.onopen = () => this.sendState();
    this.stateChannel.onclose = () => this.end("Guest left. Sharing ended; local reception continues.");
    // Guests have no hardware command path. Incoming data is intentionally ignored.
    this.unsubscribeState = controller.subscribe(snapshot => {
      const next = sharedState(snapshot);
      if (next.source !== this.state.source || !["running", "tuning"].includes(snapshot.lifecycle)) {
        this.end("Receiver stopped or source changed. Sharing ended; start a new session to share again."); return;
      }
      this.audio.enabled = next.running;
      if (next.generation !== this.state.generation || !next.running) {
        this.audio.clear(); this.gaps = 0; this.missingSamples = 0; this.lastFrame = -Infinity;
      }
      this.state = next; this.sendState();
    });
    this.unsubscribeFrames = analysis.subscribeMeasurements(frame => {
      if (!this.state.running || frame.sessionGeneration !== this.state.generation || this.spectrumChannel.readyState !== "open") return;
      this.gaps += frame.droppedFramesBefore;
      this.missingSamples += frame.missingSamplesBefore ?? 0;
      if (performance.now() - this.lastFrame < 50 || this.spectrumChannel.bufferedAmount > 32_768) { this.stats.skipped++; return; }
      try {
        this.spectrumChannel.send(encodeSpectrum({ ...frame, droppedFramesBefore: this.gaps, missingSamplesBefore: this.missingSamples }));
        this.gaps = 0; this.missingSamples = 0; this.lastFrame = performance.now(); this.stats.frames++;
      } catch { this.stats.skipped++; }
    }, true);
    if (typeof BroadcastChannel === "function") {
      this.channel = new BroadcastChannel(channelName(this.id));
      this.channel.onmessage = event => {
        const value = event.data;
        if (!value || !validPeerId(value.guestId)) return;
        if (value.type === "join" && this.offer) {
          if (this.guestId && this.guestId !== value.guestId || this.pc.signalingState !== "have-local-offer") {
            this.channel?.postMessage({ type: "busy", guestId: value.guestId }); return;
          }
          this.guestId = value.guestId;
          this.channel?.postMessage({ type: "offer", guestId: this.guestId, text: this.offer });
        } else if (value.type === "answer" && value.guestId === this.guestId && typeof value.text === "string") {
          void this.acceptAnswer(value.text).catch(() => this.end("Guest connection exchange failed. Start a new session."));
        }
      };
    }
  }
  async prepare(): Promise<void> {
    await localDescription(this.pc, await this.pc.createOffer());
    if (this.closed) throw new Error("Sharing ended.");
    this.offer = describe(this.pc, this.id); this.stats.status = "Waiting for guest"; this.publish();
    this.deadline = setTimeout(() => this.end("Unused invitation expired. Start sharing to create a new one."), 10 * 60_000);
  }
  async acceptAnswer(text: string): Promise<void> {
    const answer = parseSignal(text, "answer");
    if (answer.id !== this.id) throw new Error("This answer belongs to a different sharing session.");
    if (this.closed || this.answering || this.pc.signalingState !== "have-local-offer") throw new Error("This session already has a guest or has ended.");
    this.answering = true;
    try { await this.pc.setRemoteDescription(answer.description); clearTimeout(this.deadline); this.timeout(); }
    finally { this.answering = false; }
  }
  async createKey(): Promise<string> {
    const room = await createRoom(this.offer, this.roomAbort.signal);
    if (this.closed) { leaveRoom(room.token); throw new Error("Sharing ended."); }
    this.roomToken = room.token;
    void waitForAnswer(room.token, this.roomAbort.signal).then(async answer => {
      this.roomToken = undefined;
      if (!this.closed) await this.acceptAnswer(answer);
    }).catch(() => { if (!this.closed) this.end("Session exchange ended. Start sharing to create a new key."); });
    return room.key;
  }
  private sendState(): void {
    try {
      if (this.stateChannel.readyState === "open" && this.stateChannel.bufferedAmount < 8192) this.stateChannel.send(JSON.stringify(this.state));
    } catch { /* A concurrent peer close must never break a receiver command. */ }
  }
  protected override async sampleStats(): Promise<void> { this.sendState(); await super.sampleStats(); }
  protected override publish(): void {
    if (this.audio) this.stats.audioSeconds = this.audio.seconds;
    super.publish();
  }
  override close(): void {
    if (this.closed) return;
    this.unsubscribeState?.(); this.unsubscribeFrames?.();
    if (audioCaptureTap.live === this.audio) audioCaptureTap.live = undefined;
    this.audio?.close();
    super.close();
  }
}

export class ShareGuest extends PeerBase {
  readonly stream = new MediaStream();
  private readonly guestId = newPeerId();
  private state?: SharedState;
  private lastSequence = -1;
  private processing = false;
  private joinInterval?: ReturnType<typeof setInterval>;
  constructor(private id: string, changed: (stats: PeerStats) => void, ended: (reason: string) => void,
    private readonly receivedState: (state: SharedState) => void, private readonly receivedFrame: (frame?: SpectrumFrame) => void,
    private readonly receivedAudio: (stream: MediaStream) => void, private readonly answerReady: (text: string) => void) {
    super(changed, ended);
    this.pc.ontrack = event => { if (!this.closed) { this.stream.addTrack(event.track); this.receivedAudio(this.stream); } };
    this.pc.ondatachannel = event => {
      const channel = event.channel;
      if (channel.label === "state") {
        channel.onmessage = event => {
          if (this.closed || typeof event.data !== "string") return;
          const state = parseState(event.data);
          if (!state || this.state && state.generation < this.state.generation) return;
          if (!this.state || state.generation !== this.state.generation || !state.running) { this.lastSequence = -1; this.receivedFrame(); }
          this.state = state; this.receivedState(state);
        };
        channel.onclose = () => this.end("Host ended sharing. Local receiver access was never requested.");
      } else if (channel.label === "spectrum") {
        channel.binaryType = "arraybuffer";
        channel.onmessage = event => {
          if (this.closed) return;
          const frame = decodeSpectrum(event.data);
          if (!frame || !this.state?.running || frame.sessionGeneration !== this.state.generation || frame.sequence <= this.lastSequence ||
            frame.centerFrequencyHz !== this.state.centerHz || frame.sampleRateHz !== this.state.rateHz) { this.stats.skipped++; return; }
          this.lastSequence = frame.sequence; this.stats.frames++; this.receivedFrame(frame);
        };
      } else channel.close();
    };
  }
  joinLocal(): void {
    if (!validPeerId(this.id) || typeof BroadcastChannel !== "function") throw new Error("Use manual connection exchange in this browser.");
    this.channel = new BroadcastChannel(channelName(this.id));
    this.channel.onmessage = event => {
      const value = event.data;
      if (!value || value.guestId !== this.guestId) return;
      if (value.type === "busy") this.end("This prototype allows one guest. Ask the host to start a new session.");
      if (value.type === "offer" && typeof value.text === "string" && !this.processing) {
        clearInterval(this.joinInterval);
        void this.acceptOffer(value.text).catch(() => this.end("Could not join. Ask the host for a new invitation."));
      }
    };
    this.channel.postMessage({ type: "join", guestId: this.guestId });
    this.joinInterval = setInterval(() => this.channel?.postMessage({ type: "join", guestId: this.guestId }), 1000);
    this.timeout();
  }
  async joinKey(key: string): Promise<void> {
    const room = await joinRoom(key, this.roomAbort.signal);
    this.roomToken = room.token;
    if (this.closed) { leaveRoom(room.token); return; }
    this.id = parseSignal(room.offer, "offer").id;
    const answer = await this.acceptOffer(room.offer);
    if (answer && !this.closed) { await sendAnswer(room.token, answer, this.roomAbort.signal); this.roomToken = undefined; }
  }
  async acceptOffer(text: string): Promise<string | undefined> {
    const offer = parseSignal(text, "offer");
    if (offer.id !== this.id || this.closed || this.processing) throw new Error("Use a new guest connection for this offer.");
    this.processing = true;
    await this.pc.setRemoteDescription(offer.description);
    await localDescription(this.pc, await this.pc.createAnswer());
    if (this.closed) return;
    const answer = describe(this.pc, this.id); this.answerReady(answer);
    this.channel?.postMessage({ type: "answer", guestId: this.guestId, text: answer });
    clearTimeout(this.deadline); this.timeout();
    return answer;
  }
  override close(): void {
    if (this.closed) return;
    clearInterval(this.joinInterval); this.stream.getTracks().forEach(track => track.stop());
    this.receivedFrame(); super.close();
  }
}

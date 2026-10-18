import type { LiveAudioTap } from "../radio/audioCaptureTap";

/** Uses the existing receiver context; never connects to its speakers or closes it. */
export class ShareAudioPublisher implements LiveAudioTap {
  private context?: AudioContext;
  private destination?: MediaStreamAudioDestinationNode;
  private owner?: object;
  private readonly nodes = new Set<AudioBufferSourceNode>();
  private nextTime = 0;
  private pendingLeft = new Float32Array(960);
  private pendingRight = new Float32Array(960);
  private count = 0;
  private rate = 0;
  enabled = true;
  closed = false;
  seconds = 0;
  drops = 0;
  constructor(private readonly trackChanged: (track: MediaStreamTrack) => void) {}
  push(owner: object, left: Float32Array, right: Float32Array, rate: number, context: AudioContext): void {
    if (!this.enabled || this.closed || context.state !== "running" || left.length !== right.length || !left.length || rate < 8000 || rate > 96000) return;
    try {
      if (this.owner !== owner || this.rate !== rate) { this.clear(); this.owner = owner; this.rate = rate; }
      if (context !== this.context) {
        this.clear(); this.releaseTrack(); this.context = context;
        this.destination = context.createMediaStreamDestination();
        this.trackChanged(this.destination.stream.getAudioTracks()[0]!);
      }
      for (let offset = 0; offset < left.length;) {
        const length = Math.min(960 - this.count, left.length - offset);
        this.pendingLeft.set(left.subarray(offset, offset + length), this.count);
        this.pendingRight.set(right.subarray(offset, offset + length), this.count);
        this.count += length; offset += length;
        if (this.count === 960) { this.schedule(); this.count = 0; }
      }
    } catch { this.drops++; this.clear(); }
  }
  private schedule(): void {
    const context = this.context!, destination = this.destination!;
    if (this.nextTime - context.currentTime > .25 || this.nodes.size >= 32) { this.drops++; this.clear(); }
    const buffer = context.createBuffer(2, 960, this.rate);
    buffer.copyToChannel(this.pendingLeft, 0); buffer.copyToChannel(this.pendingRight, 1);
    const node = context.createBufferSource(); node.buffer = buffer; node.connect(destination);
    node.onended = () => { this.nodes.delete(node); node.disconnect(); };
    this.nodes.add(node);
    const start = Math.max(this.nextTime, context.currentTime + .025);
    node.start(start); this.nextTime = start + 960 / this.rate; this.seconds += 960 / this.rate;
  }
  boundary(owner: object): void { if (owner === this.owner) this.clear(); }
  clear(): void {
    for (const node of this.nodes) { node.onended = null; try { node.stop(); } catch { /* Already ended. */ } node.disconnect(); }
    this.nodes.clear(); this.count = 0; this.nextTime = 0;
  }
  private releaseTrack(): void {
    this.destination?.stream.getTracks().forEach(track => track.stop());
    this.destination?.disconnect(); this.destination = undefined;
  }
  close(): void { this.closed = true; this.clear(); this.releaseTrack(); this.context = undefined; }
}

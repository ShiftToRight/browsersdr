/** Mono processed server audio. Bounded scheduling; this graph never enters the RF analysis/recording path. */
export class RemoteAudio {
  private context?: AudioContext;
  private gain?: GainNode;
  private nodes = new Set<AudioBufferSourceNode>();
  private end = 0;
  drops = 0;
  get state() {
    return this.context?.state ?? "closed";
  }
  async resume(volume: number) {
    this.context ??= new AudioContext();
    this.gain ??= this.context.createGain();
    this.gain.disconnect();
    this.gain.connect(this.context.destination);
    this.volume(volume);
    const context = this.context;
    await context.resume();
    if (context !== this.context) return;
    if (context.state !== "running")
      throw new Error("Audio is paused by the browser. Press Resume audio.");
  }
  volume(value: number) {
    if (this.gain) this.gain.gain.value = Math.max(0, Math.min(1, value));
  }
  push(samples: Float32Array, rate: number) {
    const context = this.context;
    if (
      !context ||
      context.state !== "running" ||
      !this.gain ||
      !samples.length
    )
      return;
    if (samples.length / rate > 0.5) {
      this.drops++;
      return;
    }
    if (this.end - context.currentTime > 0.5 || this.nodes.size >= 64) {
      this.flush();
      this.drops++;
    }
    const buffer = context.createBuffer(1, samples.length, rate);
    buffer.getChannelData(0).set(samples);
    const node = context.createBufferSource();
    node.buffer = buffer;
    node.connect(this.gain);
    this.nodes.add(node);
    node.onended = () => {
      this.nodes.delete(node);
      node.disconnect();
    };
    const start = Math.max(context.currentTime + 0.025, this.end);
    this.end = start + samples.length / rate;
    node.start(start);
  }
  flush() {
    for (const node of this.nodes) {
      node.onended = null;
      try {
        node.stop();
      } catch {
        /* Already ended. */
      }
      node.disconnect();
    }
    this.nodes.clear();
    this.end = 0;
  }
  close() {
    this.flush();
    const context = this.context;
    this.context = undefined;
    this.gain = undefined;
    if (context) void context.close().catch(() => undefined);
  }
}

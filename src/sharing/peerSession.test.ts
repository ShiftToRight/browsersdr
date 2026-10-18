import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ShareGuest, ShareHost } from "./peerSession";
import { audioCaptureTap } from "../radio/audioCaptureTap";
import { decodeSpectrum, encodeSpectrum, SHARE_SCHEMA } from "./protocol";
import type { ReceiverController, ReceiverSnapshot } from "../radio/receiverController";
import type { AnalysisPipeline } from "../dsp/analysisPipeline";
import type { SpectrumFrame } from "../radio/types";

class Channel {
  readyState = "open"; bufferedAmount = 0; binaryType = "arraybuffer";
  onopen?: () => void; onclose?: () => void; onmessage?: (event: { data: unknown }) => void;
  send = vi.fn(); close = vi.fn();
  constructor(readonly label: string) {}
}
class Peer {
  static latest: Peer;
  channels: Channel[] = [];
  signalingState = "stable"; iceGatheringState = "complete"; connectionState = "new";
  onconnectionstatechange?: () => void; ontrack?: (event: { track: unknown }) => void;
  ondatachannel?: (event: { channel: Channel }) => void;
  localDescription?: { toJSON(): unknown };
  close = vi.fn(() => { this.signalingState = "closed"; });
  constructor() { Peer.latest = this; }
  createDataChannel(label: string) { const channel = new Channel(label); this.channels.push(channel); return channel; }
  addTransceiver() { return { sender: { replaceTrack: vi.fn(async () => {}) } }; }
  async createOffer() { return { type: "offer", sdp: "v=0\r\na=rtpmap:111 opus/48000/2\r\na=fmtp:111 minptime=10\r\n" }; }
  async setLocalDescription(description: unknown) { this.signalingState = "have-local-offer"; this.localDescription = { toJSON: () => description }; }
  async setRemoteDescription() { this.signalingState = "stable"; }
  async getStats() { return new Map(); }
}
function rig() {
  let snapshot = { lifecycle: "running", sessionGeneration: 3, session: { source: "rtl-sdr", mode: "AM", selectedChannelFrequencyHz: 100e6,
    hardwareCenterFrequencyHz: 100e6, actualSampleRateHz: 2.4e6 } } as ReceiverSnapshot;
  let listener: (s: ReceiverSnapshot) => void = () => {};
  let onFrame: (f: SpectrumFrame) => void = () => {};
  const unsubscribeState = vi.fn(), unsubscribeFrame = vi.fn(), stopped = vi.fn(), ended = vi.fn();
  const controller = { getSnapshot: () => snapshot, subscribe: (fn: typeof listener) => { listener = fn; return unsubscribeState; }, stop: stopped } as unknown as ReceiverController;
  const analysis = { subscribeMeasurements: (fn: typeof onFrame) => { onFrame = fn; return unsubscribeFrame; } } as unknown as AnalysisPipeline;
  return { controller, analysis, ended, stopped, unsubscribeState, unsubscribeFrame,
    change: (next: Partial<ReceiverSnapshot>) => { snapshot = { ...snapshot, ...next }; listener(snapshot); },
    frame: (sequence: number, missing = 0, generation = 3) => onFrame({ sessionGeneration: generation, sequence, timestampMs: 10,
      sampleIndex: 8192 * sequence, centerFrequencyHz: 100e6, sampleRateHz: 2.4e6, bins: new Float32Array(4096),
      droppedFramesBefore: 0, missingSamplesBefore: missing, units: "relative-dB" }),
  };
}
beforeEach(() => {
  vi.useFakeTimers(); vi.stubGlobal("RTCPeerConnection", Peer); vi.stubGlobal("BroadcastChannel", undefined);
  vi.stubGlobal("MediaStream", class { addTrack() {} getTracks() { return []; } });
});
afterEach(() => { audioCaptureTap.live?.boundary({}); audioCaptureTap.live = undefined; vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

it("accumulates source gaps across throttled rows, rejects stale generations and bounds congestion", async () => {
  let now = 0; vi.spyOn(performance, "now").mockImplementation(() => now);
  const r = rig(), host = new ShareHost(r.controller, r.analysis, vi.fn(), r.ended); await host.prepare();
  const spectrum = Peer.latest.channels.find(c => c.label === "spectrum")!;
  r.frame(1); now = 10; r.frame(2, 20); now = 150; r.frame(3, 10);
  expect(spectrum.send).toHaveBeenCalledTimes(2);
  expect(decodeSpectrum(spectrum.send.mock.calls[1]![0])?.missingSamplesBefore).toBe(30);
  r.frame(4, 0, 2); spectrum.bufferedAmount = 65536; now = 300; r.frame(5);
  expect(spectrum.send).toHaveBeenCalledTimes(2);
  host.close(); expect(r.unsubscribeFrame).toHaveBeenCalledOnce(); expect(audioCaptureTap.live).toBeUndefined();
});
it("source Stop closes publishing and subscriptions without issuing any receiver Stop of its own", async () => {
  const r = rig(), host = new ShareHost(r.controller, r.analysis, vi.fn(), r.ended); await host.prepare();
  r.change({ lifecycle: "stopping" }); host.close();
  expect(Peer.latest.close).toHaveBeenCalledOnce(); expect(r.ended).toHaveBeenCalledOnce();
  expect(r.unsubscribeState).toHaveBeenCalledOnce(); expect(r.stopped).not.toHaveBeenCalled(); expect(audioCaptureTap.live).toBeUndefined();
});
it("rejects another-session answers, disallows a second accepted answer and expires unused invitations", async () => {
  const r = rig(), host = new ShareHost(r.controller, r.analysis, vi.fn(), r.ended); await host.prepare();
  const answer = (id: string) => JSON.stringify({ schema: SHARE_SCHEMA, id, description: { type: "answer", sdp: "v=0\r\na=temporary-network-details\r\n" } });
  await expect(host.acceptAnswer(answer("ab".repeat(16)))).rejects.toThrow("different sharing session");
  await host.acceptAnswer(answer(host.id)); await expect(host.acceptAnswer(answer(host.id))).rejects.toThrow("already has a guest"); host.close();
  const other = new ShareHost(r.controller, r.analysis, vi.fn(), r.ended); await other.prepare();
  await vi.advanceTimersByTimeAsync(600_001); expect(r.ended).toHaveBeenLastCalledWith(expect.stringContaining("expired"));
});
it("guest rejects old, duplicate and wrong-window FFT and clears its plot on generation changes", () => {
  const frame = vi.fn(), state = vi.fn(), guest = new ShareGuest("ab".repeat(16), vi.fn(), vi.fn(), state, frame, vi.fn(), vi.fn());
  const peer = Peer.latest, reliable = new Channel("state"), spectrum = new Channel("spectrum");
  peer.ondatachannel!({ channel: reliable }); peer.ondatachannel!({ channel: spectrum });
  const message = { type: "state", generation: 3, running: true, source: "rtl-sdr", mode: "AM", frequencyHz: 100e6, centerHz: 100e6, rateHz: 2.4e6 };
  reliable.onmessage!({ data: JSON.stringify(message) }); frame.mockClear();
  const wire = (generation: number, center = 100e6) => encodeSpectrum({ sessionGeneration: generation, sequence: 1, timestampMs: 10, sampleIndex: 1000,
    centerFrequencyHz: center, sampleRateHz: 2.4e6, bins: new Float32Array(4096), droppedFramesBefore: 0, units: "relative-dB" });
  spectrum.onmessage!({ data: wire(2) }); spectrum.onmessage!({ data: wire(3, 99e6) }); expect(frame).not.toHaveBeenCalled();
  spectrum.onmessage!({ data: wire(3) }); spectrum.onmessage!({ data: wire(3) }); expect(frame).toHaveBeenCalledOnce();
  reliable.onmessage!({ data: JSON.stringify({ ...message, generation: 4 }) }); expect(frame).toHaveBeenLastCalledWith();
  reliable.onmessage!({ data: JSON.stringify(message) }); expect(state).toHaveBeenCalledTimes(2); guest.close();
});

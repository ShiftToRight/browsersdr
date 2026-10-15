import { DabReceiver, type DabEnsembleDecoder } from "../dab/dabReceiver";
import { DabAudioPlayer, DabPcmPlayer, WebCodecsDabAudioDecoder, type DabWebCodecsBindings } from "../dab/dabAudio";
import { DabPlusProgrammeDecoder } from "../dab/dabPlusSuperframe";
import { DabEnsembleWorkerDecoder } from "../dab/dabEnsembleWorker";
import { DabModeIProcessor } from "../dab/dabModeI";
import type { ReceiverBackendEvents } from "./receiverController";

/** Replay uses the same OFDM/FIC/MSC, DAB+ and HE-AAC components as live reception. */
export function createDabReplayPlayback(context: AudioContext, events: ReceiverBackendEvents, volume: number, bindings?: DabWebCodecsBindings, provenance?: () => string) {
  const output = new DabAudioPlayer(context, provenance);
  output.setVolume(volume);
  const pcm = new DabPcmPlayer(output);
  let active = true;
  const programme = new DabPlusProgrammeDecoder(new WebCodecsDabAudioDecoder(
    (left, right, rate) => {
      if (!active) return;
      pcm.play(left, right, rate);
      receiver.recordPcm(left.length, rate);
    }, status => {
      if (!active) return;
      receiver.updateAudioStatus(status);
      if (status.state === "error") events.runtimeError(new Error(status.message));
    }, bindings), stats => { if (active) receiver.updateProgrammeStats(stats); },
    error => { if (active) events.runtimeError(error); },
    metadata => { if (active) receiver.updateProgrammeMetadata(metadata); });
  const changed = () => { if (active) { programme.reset(); pcm.reset(); output.reset(); receiver.resetProgramme(); } };
  const status = (value: Parameters<DabReceiver["updateDecoderStatus"]>[0]) => { if (active) receiver.updateDecoderStatus(value); };
  const error = (value: Error) => { if (active) events.runtimeError(value); };
  let ensemble: DabEnsembleDecoder;
  if (typeof Worker !== "undefined") {
    ensemble = new DabEnsembleWorkerDecoder(programme, status, error, undefined, changed);
  } else {
    // Headless/non-worker environments still exercise the complete decoder.
    const processor = new DabModeIProcessor(data => programme.pushLogicalFrame(data), status, changed);
    ensemble = { setSampleRate: rate => processor.setSampleRate(rate),
      receiveSamples: block => processor.push(block.I, block.Q), reset: () => processor.reset(),
      selectService: key => processor.selectService(key) };
  }
  const receiver = new DabReceiver(snapshot => { if (active) events.dabChanged?.(snapshot); }, ensemble);
  return { receiver, ensemble, output,
    flush: async () => { await ensemble.drain?.(); await programme.flush(); receiver.flushStatus(); await output.whenIdle(); },
    reset: () => { receiver.reset(); programme.reset(); pcm.reset(); output.reset(); },
    close: () => { active = false; receiver.close(); programme.close(); pcm.reset(); output.dispose(); },
  };
}

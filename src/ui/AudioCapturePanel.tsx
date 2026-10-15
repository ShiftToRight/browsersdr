import { useEffect, useRef, useState } from "react";
import { audioArchive, AUDIO_RECORD_SECONDS, AUDIO_REWIND_SECONDS } from "../radio/audioArchive";

function download(blob: Blob, label: string): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url; anchor.download = `browsersdr-audio-${label}-${new Date().toISOString().replace(/[:.]/g, "-")}.wav`;
  anchor.click(); window.setTimeout(() => URL.revokeObjectURL(url), 30_000);
}

export function AudioCaptureControls() {
  const [, refresh] = useState(0);
  const [seconds, setSeconds] = useState(15);
  const [review, setReview] = useState<{ url: string; revision: number }>();
  const [error, setError] = useState("");
  const player = useRef<HTMLAudioElement>(null);
  const update = () => refresh(value => value + 1);
  const attempt = (action: () => void) => { try { setError(""); action(); } catch (reason) { setError((reason as Error).message); } update(); };
  useEffect(() => {
    const timer = window.setInterval(() => refresh(value => value + 1), 250);
    return () => clearInterval(timer);
  }, []);
  useEffect(() => () => {
    if (review) { URL.revokeObjectURL(review.url); audioArchive.setReviewing(false); }
  }, [review]);
  const stale = review && review.revision !== audioArchive.revision;
  useEffect(() => {
    if (stale) { player.current?.pause(); audioArchive.setReviewing(false); }
  }, [stale]);
  return <div className="audio-capture-body">
      <p>Save decoded audio as stereo WAV, before the volume control. Data-only modes such as ADS-B produce no audio. Recordings stay in memory; download before closing.</p>
      <div className="audio-capture-actions">
        <button type="button" disabled={!audioArchive.recording && audioArchive.hasRecording} onClick={() => attempt(() => audioArchive.recording ? audioArchive.stopRecording() : audioArchive.startRecording())}>{audioArchive.recording ? "Stop audio recording" : "Record audio"}</button>
        <button type="button" className="secondary" disabled={audioArchive.recording || !audioArchive.hasRecording} onClick={() => attempt(() => download(audioArchive.recordingWav(), "recording"))}>Download audio WAV</button>
        <button type="button" className="secondary" disabled={audioArchive.recording || !audioArchive.hasRecording} onClick={() => attempt(() => audioArchive.discard())}>Discard audio</button>
        <span>{audioArchive.recordedSeconds.toFixed(1)} / {AUDIO_RECORD_SECONDS} s</span>
      </div>
      <label className="audio-rewind-toggle"><input type="checkbox" checked={audioArchive.rewindEnabled} onChange={event => attempt(() => audioArchive.setRewind(event.target.checked))} />Keep last {AUDIO_REWIND_SECONDS} seconds for rewind</label>
      <div className="audio-capture-actions">
        <label>Rewind window <select value={seconds} onChange={event => setSeconds(Number(event.target.value))}>{[5, 15, 30, 60].map(value => <option key={value} value={value}>{value} seconds</option>)}</select></label>
        <button type="button" className="secondary" disabled={!audioArchive.rewindSeconds} onClick={() => attempt(() => {
          player.current?.pause(); audioArchive.setReviewing(false);
          setReview({ url: URL.createObjectURL(audioArchive.rewindWav(seconds)), revision: audioArchive.revision });
        })}>Rewind audio</button>
        <button type="button" className="secondary" disabled={!audioArchive.rewindSeconds} onClick={() => attempt(() => download(audioArchive.rewindWav(seconds), "rewind"))}>Save rewind WAV</button>
        <span>{audioArchive.rewindSeconds.toFixed(1)} s buffered</span>
      </div>
      {review && <div className="audio-capture-actions">
        <audio ref={player} src={stale ? undefined : review.url} controls autoPlay aria-label="Rewind audio playback"
          onPlay={() => audioArchive.setReviewing(true)} onPause={() => audioArchive.setReviewing(false)} onEnded={() => audioArchive.setReviewing(false)}
          onError={() => { audioArchive.setReviewing(false); setError("Rewind playback could not start. Try saving the rewind WAV."); }} />
        <button type="button" className="secondary" onClick={() => { player.current?.pause(); audioArchive.setReviewing(false); setReview(undefined); }}>Return to live audio</button>
        <span>{stale ? "Audio source changed. Select a new rewind window." : "Live audio is muted while rewind plays; reception and recording continue."}</span>
      </div>}
      <p role="status">{error || audioArchive.message}</p>
      <small>Source, tuning, programme and detected gap changes end a recording and reset rewind. Remote recordings contain processed server audio. Memory in use: {(audioArchive.memoryBytes / 1024 / 1024).toFixed(1)} MiB.</small>
    </div>;
}

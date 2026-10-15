import { lazy, Suspense, useEffect, useState } from "react";
import { audioCaptureTap } from "../radio/audioCaptureTap";
import "./AudioCapturePanel.css";

const AudioCaptureControls = lazy(() => import("./AudioCapturePanel").then(module => ({ default: module.AudioCaptureControls })));

/** Keep the audio export/player UI out of the startup path until opened. */
export function AudioCapturePanel() {
  const [open, setOpen] = useState(false);
  const [, refresh] = useState(0);
  useEffect(() => {
    const timer = window.setInterval(() => refresh(value => value + 1), 500);
    return () => clearInterval(timer);
  }, []);
  return <details className="audio-capture-panel" open={open} onToggle={event => setOpen(event.currentTarget.open)}>
    <summary>Audio recorder &amp; rewind{audioCaptureTap.archive?.recording ? " · Recording" : audioCaptureTap.archive?.hasRecording ? " · WAV ready" : ""}</summary>
    {open && <Suspense fallback={<p role="status">Loading audio controls…</p>}><AudioCaptureControls /></Suspense>}
  </details>;
}

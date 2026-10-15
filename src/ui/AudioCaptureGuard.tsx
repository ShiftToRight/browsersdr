import { useEffect, useRef } from "react";
import { audioCaptureTap } from "../radio/audioCaptureTap";

/** Mounted above conditional/visibility-gated workspaces so retention is protected everywhere. */
export function AudioCaptureGuard({ sourceKey }: { sourceKey: string }) {
  const previous = useRef(sourceKey);
  useEffect(() => {
    if (previous.current !== sourceKey) audioCaptureTap.archive?.clearSource();
    previous.current = sourceKey;
  }, [sourceKey]);
  useEffect(() => {
    const unload = (event: BeforeUnloadEvent) => {
      if (audioCaptureTap.archive?.recording || audioCaptureTap.archive?.hasRecording) { event.preventDefault(); event.returnValue = ""; }
    };
    window.addEventListener("beforeunload", unload);
    return () => window.removeEventListener("beforeunload", unload);
  }, []);
  return null;
}

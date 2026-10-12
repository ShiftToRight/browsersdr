import { useEffect, useState } from "react";
import {
  RecordingExportCoordinator,
  type RecordingRetentionSnapshot,
} from "../radio/recordingExport";
import { cleanupAbandonedRecordings } from "../radio/recordingSpool";
import type { RecordingStatus } from "../radio/iqRecording";

/** Own prepared views and navigation protection; durable library deletion is explicit elsewhere. */
export function useCaptureRetention(
  recordingStatus: RecordingStatus | undefined,
) {
  const [exportCoordinator] = useState(() => new RecordingExportCoordinator());
  const [retainedCapture, setRetainedCapture] =
    useState<RecordingRetentionSnapshot>(() => exportCoordinator.getSnapshot());
  useEffect(() => {
    void cleanupAbandonedRecordings().catch(() => undefined);
    return () => exportCoordinator.discard();
  }, [exportCoordinator]);
  useEffect(() => {
    const pending =
      Boolean(recordingStatus) ||
      (!retainedCapture.libraryId &&
        !["empty", "discarded"].includes(retainedCapture.status));
    if (!pending) return;
    const guard = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", guard);
    return () => window.removeEventListener("beforeunload", guard);
  }, [recordingStatus, retainedCapture.libraryId, retainedCapture.status]);
  return { exportCoordinator, retainedCapture, setRetainedCapture };
}

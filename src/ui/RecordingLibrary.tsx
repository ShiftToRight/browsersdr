import { useEffect, useRef, useState } from "react";
import {
  deleteRecording,
  listRecordings,
  openRecording,
  type LibraryEntry,
} from "../radio/recordingLibrary";
import type { IqRecording } from "../radio/iqRecording";

export function RecordingLibrary({
  blocked,
  blockedReason = "Finish the current receiver operation or close the prepared capture before opening a library recording.",
  revision,
  onOpen,
}: {
  blocked: boolean;
  blockedReason?: string;
  revision: string;
  onOpen: (recording: IqRecording, replay: boolean) => Promise<void>;
}) {
  const [entries, setEntries] = useState<LibraryEntry[]>([]);
  const [message, setMessage] = useState("");
  const [working, setWorking] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [quota, setQuota] = useState("");
  const [deleteId, setDeleteId] = useState<string>();
  const refreshInFlight = useRef<Promise<void> | undefined>(undefined);
  const refreshRequested = useRef(false);
  const refresh = () => {
    refreshRequested.current = true;
    if (refreshInFlight.current) return refreshInFlight.current;
    setRefreshing(true);
    const operation = (async () => {
      try {
        do {
          refreshRequested.current = false;
          try {
            // Listing probes own the same locks as open/delete. Keep stale
            // row actions blocked until every coalesced refresh releases them.
            setEntries(
              (await listRecordings()).sort(
                (a, b) =>
                  (b.metadata?.captureStartedAt ?? b.id).localeCompare(
                    a.metadata?.captureStartedAt ?? a.id,
                  ) || a.id.localeCompare(b.id),
              ),
            );
            const estimate = await navigator.storage?.estimate?.();
            if (estimate)
              setQuota(
                (
                  Math.max(0, (estimate.quota ?? 0) - (estimate.usage ?? 0)) /
                  1024 ** 3
                ).toFixed(2) + " GiB estimated free for this origin",
              );
          } catch (error) {
            setMessage(error instanceof Error ? error.message : String(error));
          }
        } while (refreshRequested.current);
      } finally {
        refreshInFlight.current = undefined;
        setRefreshing(false);
      }
    })();
    refreshInFlight.current = operation;
    return operation;
  };
  useEffect(() => {
    void refresh();
  }, [revision]);
  const run = async (action: () => Promise<void>) => {
    setWorking(true);
    setMessage("");
    try {
      await refreshInFlight.current;
      await action();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setWorking(false);
      await refresh();
    }
  };
  return (
    <details className="recording-library">
      <summary>Local recording library ({entries.length})</summary>
      <p>
        Captures in browser storage survive reload. Interrupted captures offer
        only committed samples. Browser eviction or clearing site data can still
        remove them; download a backup. Memory fallback captures remain
        tab-local.
      </p>
      <p>{quota}</p>
      <p className="display-note">Newest recordings first.</p>
      {blocked && <p id="library-open-help" role="status">{blockedReason}</p>}
      <button
        className="secondary"
        type="button"
        disabled={working || refreshing}
        onClick={() => void refresh()}
      >
        Refresh library
      </button>
      <button
        className="secondary"
        type="button"
        disabled={working || refreshing}
        onClick={() =>
          void run(async () => {
            const granted = await navigator.storage?.persist?.();
            setMessage(
              granted
                ? "Persistent storage granted. Keep external backups."
                : "Persistent storage was not granted; browser eviction remains possible.",
            );
          })
        }
      >
        Keep browser storage
      </button>
      {entries.map((entry) => (
        <div key={entry.id} className="recording-library-entry">
          <p>
            {entry.metadata?.captureStartedAt ?? entry.id} · {entry.state} ·{" "}
            {(entry.bytes / 1024 ** 2).toFixed(2)} MiB
            {entry.metadata && (
              <>
                {" "}
                · {(entry.metadata.centerFrequencyHz / 1e6).toFixed(3)} MHz ·{" "}
                {entry.metadata.durationSeconds.toFixed(2)} s
              </>
            )}
            {entry.error && <> · {entry.error}</>}
          </p>
          {(["ready", "interrupted"] as string[]).includes(entry.state) && (
            <>
              <button
                className="secondary"
                type="button"
                disabled={blocked || working || refreshing}
                aria-describedby={blocked ? "library-open-help" : undefined}
                onClick={() =>
                  void run(async () =>
                    onOpen(await openRecording(entry.id), true),
                  )
                }
              >
                Replay retained recording
              </button>
              <button
                className="secondary"
                type="button"
                disabled={blocked || working || refreshing}
                onClick={() =>
                  void run(async () =>
                    onOpen(await openRecording(entry.id), false),
                  )
                }
              >
                Prepare retained download
              </button>
            </>
          )}
          <button
            className="secondary destructive library-delete"
            type="button"
            disabled={
              blocked || working || refreshing || entry.state === "in-use"
            }
            onClick={() => setDeleteId(entry.id)}
          >
            Delete retained recording
          </button>
          {deleteId === entry.id && (
            <div
              className="library-delete-confirm"
              role="group"
              aria-label="Confirm recording deletion"
            >
              <p>
                Delete this recording from browser storage? Download a backup
                first. This cannot be undone.
              </p>
              <button
                className="secondary destructive"
                disabled={
                  blocked || working || refreshing || entry.state === "in-use"
                }
                onClick={() =>
                  void run(async () => {
                    await deleteRecording(entry.id);
                    setDeleteId(undefined);
                  })
                }
              >
                Confirm delete recording
              </button>
              <button
                className="secondary"
                onClick={() => setDeleteId(undefined)}
              >
                Keep recording
              </button>
            </div>
          )}
        </div>
      ))}
      <p role="status">{message}</p>
    </details>
  );
}

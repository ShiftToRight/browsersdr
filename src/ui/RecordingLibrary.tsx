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
  revision,
  onOpen,
}: {
  blocked: boolean;
  revision: string;
  onOpen: (recording: IqRecording, replay: boolean) => Promise<void>;
}) {
  const [entries, setEntries] = useState<LibraryEntry[]>([]);
  const [message, setMessage] = useState("");
  const [working, setWorking] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [quota, setQuota] = useState("");
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
            setEntries(await listRecordings());
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
            className="secondary"
            type="button"
            disabled={
              blocked || working || refreshing || entry.state === "in-use"
            }
            onClick={() => void run(async () => deleteRecording(entry.id))}
          >
            Delete retained recording
          </button>
        </div>
      ))}
      <p role="status">{message}</p>
    </details>
  );
}

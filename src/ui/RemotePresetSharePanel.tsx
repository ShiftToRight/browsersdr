import { useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  hasRemoteShare,
  readRemoteShare,
  type RemotePreset,
} from "../remote/remotePresets";
import { REMOTE_MODES, receiverUrl } from "../remote/openWebRxProtocol";
import { AppIcon } from "./AppIcon";

export function RemotePresetSharePanel({
  blockedReason,
  onApply,
}: {
  blockedReason?: string;
  onApply: (preset: RemotePreset) => Promise<void>;
}) {
  const [incoming, setIncoming] = useState(() =>
    readRemoteShare(location.hash),
  );
  const [open, setOpen] = useState(
    () =>
      hasRemoteShare(location.hash) &&
      !new URLSearchParams(location.hash.slice(1)).has("settings"),
  );
  const [message, setMessage] = useState("");
  const [applying, setApplying] = useState(false);
  const busy = useRef(false);
  const dialog = useRef<HTMLDialogElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const id = useId();
  useEffect(() => {
    const read = () => {
      if (busy.current) return;
      setIncoming(readRemoteShare(location.hash));
      setMessage("");
      setOpen(
        hasRemoteShare(location.hash) &&
          !new URLSearchParams(location.hash.slice(1)).has("settings"),
      );
    };
    window.addEventListener("hashchange", read);
    return () => window.removeEventListener("hashchange", read);
  }, []);
  useEffect(() => {
    const panel = dialog.current;
    if (!panel) return;
    if (open && !panel.open) {
      panel.showModal();
      panel.querySelector<HTMLButtonElement>("button")?.focus();
    } else if (!open && panel.open) {
      panel.close();
      trigger.current?.focus();
    }
  }, [open]);
  let connectionIssue = "";
  if (incoming.preset) {
    try {
      receiverUrl(incoming.preset.address);
    } catch (reason) {
      connectionIssue = (reason as Error).message;
    }
  }
  const issue = blockedReason || connectionIssue;
  const apply = async () => {
    if (!incoming.preset || issue || busy.current) return;
    busy.current = true;
    setApplying(true);
    setMessage("");
    try {
      await onApply(incoming.preset);
      const url = new URL(location.href);
      url.hash = "";
      url.search = "";
      history.replaceState(history.state, "", url);
      setIncoming({});
      setOpen(false);
      setMessage(
        "Remote preset loaded. Connect, review the saved channel, then Listen when ready.",
      );
    } catch (reason) {
      setMessage(
        reason instanceof Error
          ? reason.message
          : "The remote preset could not be loaded.",
      );
    } finally {
      busy.current = false;
      setApplying(false);
    }
  };
  const dismiss = () => {
    if (!busy.current) setOpen(false);
  };
  return (
    <>
      {(incoming.preset || incoming.error) && (
        <button
          ref={trigger}
          className="secondary remote-incoming-trigger"
          type="button"
          aria-haspopup="dialog"
          aria-controls={id}
          onClick={() => setOpen(true)}
        >
          <AppIcon name="share" /> Review remote preset
        </button>
      )}
      {!open && message && (
        <span className="visually-hidden" role="status">
          {message}
        </span>
      )}
      {createPortal(
        <dialog
          ref={dialog}
          id={id}
          className="settings-share-dialog"
          aria-labelledby={`${id}-heading`}
          onCancel={(e) => {
            e.preventDefault();
            dismiss();
          }}
          onClick={(e) => {
            if (e.target !== e.currentTarget) return;
            const r = e.currentTarget.getBoundingClientRect();
            if (
              e.clientX < r.left ||
              e.clientX > r.right ||
              e.clientY < r.top ||
              e.clientY > r.bottom
            )
              dismiss();
          }}
          onKeyDown={(e) => {
            if (e.key !== "Tab") return;
            const controls = [
              ...e.currentTarget.querySelectorAll<HTMLElement>(
                "button:not(:disabled), a[href]",
              ),
            ];
            const first = controls[0],
              last = controls.at(-1);
            if (e.shiftKey && document.activeElement === first) {
              e.preventDefault();
              last?.focus();
            } else if (!e.shiftKey && document.activeElement === last) {
              e.preventDefault();
              first?.focus();
            }
          }}
        >
          <div className="settings-share-header">
            <h2 id={`${id}-heading`}>Shared remote preset</h2>
            <button
              type="button"
              className="secondary"
              disabled={applying}
              aria-label="Close remote preset"
              onClick={dismiss}
            >
              <AppIcon name="close" />
            </button>
          </div>
          <p className="display-note">
            Review this receiver and its requested settings. Applying
            disconnects the current receiver and stages the remote workspace.
            Connect and Listen stay manual; nothing is saved to Favorites
            automatically.
          </p>
          {incoming.error && (
            <p role="alert">Cannot use this remote link: {incoming.error}</p>
          )}
          {incoming.preset && (
            <>
              <dl className="settings-share-summary">
                <div>
                  <dt>Receiver</dt>
                  <dd>
                    {incoming.preset.kind === "kiwi" ? "KiwiSDR" : "OpenWebRX"}
                  </dd>
                </div>
                <div>
                  <dt>Website</dt>
                  <dd>{incoming.preset.address}</dd>
                </div>
                {incoming.preset.tune && (
                  <>
                    <div>
                      <dt>Channel</dt>
                      <dd>
                        {incoming.preset.tune.frequency / 1e6} MHz ·{" "}
                        {REMOTE_MODES[incoming.preset.tune.mode]}
                      </dd>
                    </div>
                    <div>
                      <dt>Filter</dt>
                      <dd>
                        {incoming.preset.tune.lowCut}…
                        {incoming.preset.tune.highCut} Hz
                      </dd>
                    </div>
                  </>
                )}
                {incoming.preset.profile && (
                  <div>
                    <dt>Saved band</dt>
                    <dd>{incoming.preset.profile}</dd>
                  </div>
                )}
                {incoming.preset.zoom !== undefined && (
                  <div>
                    <dt>Zoom</dt>
                    <dd>{2 ** incoming.preset.zoom}×</dd>
                  </div>
                )}
              </dl>
              <button
                type="button"
                disabled={Boolean(issue) || applying}
                onClick={() => void apply()}
              >
                {applying ? "Loading…" : "Load remote preset"}
              </button>
              {issue && <p className="display-note">{issue}</p>}
              {connectionIssue && (
                <a
                  href={incoming.preset.address}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  Open receiver website ↗
                </a>
              )}
            </>
          )}
          <p role="status" className="display-note">
            {message}
          </p>
        </dialog>,
        document.body,
      )}
    </>
  );
}

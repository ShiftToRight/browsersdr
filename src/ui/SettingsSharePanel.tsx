import { useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  createSettingsShareUrl,
  hasSettingsShare,
  readSettingsShare,
  type SharedSettings,
} from "../radio/settingsShare";
import { AppIcon } from "./AppIcon";

export function SettingsSharePanel({
  current,
  blockedReason,
  applyBlockedReason,
  onApply,
}: {
  current: SharedSettings;
  blockedReason?: string;
  applyBlockedReason?: string;
  onApply: (settings: SharedSettings) => Promise<void>;
}) {
  const [incoming, setIncoming] = useState(() =>
    readSettingsShare(location.hash),
  );
  const [open, setOpen] = useState(() => hasSettingsShare(location.hash));
  const [outgoing, setOutgoing] = useState<SharedSettings>();
  const [link, setLink] = useState("");
  const [message, setMessage] = useState("");
  const [applying, setApplying] = useState(false);
  const dialog = useRef<HTMLDialogElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const linkInput = useRef<HTMLTextAreaElement>(null);
  const id = useId();
  const applyingRef = useRef(false);
  useEffect(() => {
    const read = () => {
      if (applyingRef.current) return;
      setIncoming(readSettingsShare(location.hash));
      setOutgoing(undefined);
      setMessage("");
      setOpen(hasSettingsShare(location.hash));
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
      const destination = trigger.current?.getClientRects().length
        ? trigger.current
        : document.querySelector<HTMLButtonElement>(
            ".workspace-controls button",
          );
      destination?.focus();
    }
  }, [open]);
  const dismiss = () => {
    if (!applyingRef.current) setOpen(false);
  };
  const create = () => {
    try {
      setLink(createSettingsShareUrl(location.href, current));
      setOutgoing(current);
      setIncoming({});
      setMessage("");
    } catch (error) {
      setOutgoing(undefined);
      setLink("");
      setMessage(
        error instanceof Error ? error.message : "Check the channel settings.",
      );
    }
    setOpen(true);
  };
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(link);
      setMessage("Link copied.");
    } catch {
      linkInput.current?.focus();
      linkInput.current?.select();
      setMessage("Select and copy the link below.");
    }
  };
  const apply = async () => {
    if (!incoming.settings || applyBlockedReason || applyingRef.current) return;
    applyingRef.current = true;
    setApplying(true);
    try {
      await onApply(incoming.settings);
      setIncoming({});
      // Applying consumes this proposal; reloading must not unexpectedly offer it again.
      const url = new URL(location.href);
      url.hash = "";
      url.search = "";
      history.replaceState(history.state, "", url);
      setMessage(
        "Shared settings applied. Connect if needed, then press Start when ready.",
      );
      setOpen(false);
    } catch (error) {
      setMessage(
        error instanceof Error
          ? error.message
          : "Settings could not be applied.",
      );
    } finally {
      applyingRef.current = false;
      setApplying(false);
    }
  };
  const proposal = incoming.settings ?? outgoing;
  return (
    <>
      <div className="session-share-actions">
        <button
          ref={trigger}
          type="button"
          className="secondary"
          aria-haspopup="dialog"
          aria-controls={id}
          disabled={
            !incoming.settings && !incoming.error && Boolean(blockedReason)
          }
          title={blockedReason}
          onClick={() =>
            incoming.settings || incoming.error ? setOpen(true) : create()
          }
        >
          <AppIcon name="share" />
          {incoming.settings || incoming.error
            ? "Review shared settings"
            : "Share settings"}
        </button>
        <span className="visually-hidden" role="status">
          {!open ? message : ""}
        </span>
      </div>
      {createPortal(
        <dialog
          ref={dialog}
          id={id}
          className="settings-share-dialog"
          aria-labelledby={`${id}-heading`}
          onCancel={(event) => {
            event.preventDefault();
            dismiss();
          }}
          onClick={(event) => {
            if (event.target === event.currentTarget) {
              const rect = event.currentTarget.getBoundingClientRect();
              if (
                event.clientX < rect.left ||
                event.clientX > rect.right ||
                event.clientY < rect.top ||
                event.clientY > rect.bottom
              )
                dismiss();
            }
          }}
          onKeyDown={(event) => {
            if (event.key !== "Tab") return;
            const controls = [
              ...event.currentTarget.querySelectorAll<HTMLElement>(
                "button:not(:disabled), textarea",
              ),
            ];
            const first = controls[0],
              last = controls.at(-1);
            if (event.shiftKey && document.activeElement === first) {
              event.preventDefault();
              last?.focus();
            } else if (!event.shiftKey && document.activeElement === last) {
              event.preventDefault();
              first?.focus();
            }
          }}
        >
          <div className="settings-share-header">
            <h2 id={`${id}-heading`}>
              {incoming.settings || incoming.error
                ? "Shared settings"
                : "Share settings"}
            </h2>
            <button
              type="button"
              className="secondary"
              aria-label="Close settings share"
              disabled={applying}
              onClick={dismiss}
            >
              <AppIcon name="close" />
            </button>
          </div>
          <p className="display-note">
            A tuning preset only. Audio, recordings, favorites and connection
            details are excluded. Connecting and Start remain manual.
          </p>
          {incoming.error && (
            <p role="alert">Cannot use this settings link: {incoming.error}</p>
          )}
          {proposal && (
            <dl className="settings-share-summary">
              <div>
                <dt>Channel</dt>
                <dd>
                  {proposal.frequencyHz / 1e6} MHz · {proposal.settings.mode}
                </dd>
              </div>
              <div>
                <dt>Bandwidth</dt>
                <dd>{proposal.settings.bandwidthHz.toLocaleString()} Hz</dd>
              </div>
              <div>
                <dt>Display</dt>
                <dd>
                  {proposal.display.compact ? "Compact" : "Comfortable"} · floor{" "}
                  {proposal.display.floorDb} dB · range{" "}
                  {proposal.display.rangeDb} dB
                </dd>
              </div>
              {proposal.settings.mode === "CW" && (
                <div>
                  <dt>Beat tone</dt>
                  <dd>{proposal.settings.beatToneHz} Hz</dd>
                </div>
              )}
              {proposal.settings.mode === "SRD" && (
                <div>
                  <dt>SRD</dt>
                  <dd>
                    {proposal.settings.srd?.modulation.toUpperCase()} ·{" "}
                    {proposal.settings.srd?.protocol}
                  </dd>
                </div>
              )}
              <div>
                <dt>Squelch</dt>
                <dd>{proposal.settings.squelch}</dd>
              </div>
            </dl>
          )}
          {incoming.settings && (
            <>
              <p className="display-note">
                Uses your selected source. Review its frequency and mode support
                before starting.
              </p>
              <button
                type="button"
                disabled={Boolean(applyBlockedReason) || applying}
                onClick={() => void apply()}
              >
                {applying ? "Applying…" : "Apply shared settings"}
              </button>
              {applyBlockedReason && (
                <p className="display-note">{applyBlockedReason}</p>
              )}
            </>
          )}
          {!incoming.settings && !incoming.error && link && (
            <>
              <label className="share-link-label">
                Settings link
                <textarea
                  ref={linkInput}
                  aria-label="Settings link"
                  readOnly
                  value={link}
                  rows={3}
                  onFocus={(event) => event.currentTarget.select()}
                />
              </label>
              <button type="button" onClick={() => void copy()}>
                <AppIcon name="share" />
                Copy link
              </button>
              {new URL(link).hostname.match(/^(localhost|127\.|\[::1\]$)/) && (
                <p className="display-note">
                  This local address works on this computer. To share with
                  others, create the link on the published BrowserSDR site.
                </p>
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

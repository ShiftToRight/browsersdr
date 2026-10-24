import { useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { AppIcon } from "./AppIcon";
import { useOverlayDialog } from "./useOverlayDialog";
import {
  locationFromBrowser,
  locationIsStale,
  validateReceiverLocation,
  type ReceiverLocation,
} from "../radio/receiverLocation";

export function useReceiverLocation(scope: string) {
  const key = `browsersdr.antennaSite.v1:${scope}`;
  const [initial] = useState(() => {
    try {
      const text = localStorage.getItem(key);
      if (text && text.length > 16_384)
        throw new Error("Site storage is too large.");
      return {
        site: text ? validateReceiverLocation(JSON.parse(text)) : undefined,
        remembered: Boolean(text),
        error: "",
      };
    } catch {
      return {
        site: undefined,
        remembered: false,
        error:
          "Saved site is invalid or unavailable; it has been left untouched.",
      };
    }
  });
  const [site, setSite] = useState(initial.site);
  const [remembered, setRemembered] = useState(initial.remembered);
  const [storageError, setStorageError] = useState(initial.error);
  const change = (
    next: ReceiverLocation | undefined,
    remember = remembered,
  ) => {
    try {
      if (remember && next)
        localStorage.setItem(
          key,
          JSON.stringify(validateReceiverLocation(next)),
        );
      else localStorage.removeItem(key);
      setStorageError("");
      setRemembered(remember);
      setSite(next);
    } catch {
      setStorageError(
        "Site is available in this tab, but saving the preference failed.",
      );
      setSite(next);
    }
  };
  return { site, remembered, storageError, change };
}
export function ReceiverLocationPanel({
  value,
  remote = false,
}: {
  value: ReturnType<typeof useReceiverLocation>;
  remote?: boolean;
}) {
  const { site, remembered, storageError, change } = value;
  const [latitude, setLatitude] = useState(site?.latitude.toString() ?? "");
  const [longitude, setLongitude] = useState(site?.longitude.toString() ?? "");
  const [label, setLabel] = useState(site?.label ?? "");
  const [message, setMessage] = useState("");
  const [pending, setPending] = useState(false);
  const [now, setNow] = useState(Date.now);
  const [open, setOpen] = useState(false);
  const [coordinatesEdited, setCoordinatesEdited] = useState(false);
  const dialog = useRef<HTMLDialogElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const id = useId();
  useOverlayDialog(open, dialog, trigger, 'input[name="site-name"]');
  const request = useRef({ generation: 0 });
  const deadline = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => {
    const lifetime = request.current;
    const timer = setInterval(() => setNow(Date.now()), 30_000);
    return () => {
      clearInterval(timer);
      clearTimeout(deadline.current);
      lifetime.generation++;
    };
  }, []);
  const cancel = () => {
    request.current.generation++;
    clearTimeout(deadline.current);
    setPending(false);
  };
  const apply = (next: ReceiverLocation) => {
    change(next);
    setLatitude(String(next.latitude));
    setLongitude(String(next.longitude));
    setLabel(next.label ?? "");
    setNow(Date.now());
    setCoordinatesEdited(false);
  };
  const dismiss = () => {
    cancel();
    if (pending)
      setMessage("Request cancelled. The previous site is retained.");
    setOpen(false);
  };
  const save = () => {
    cancel();
    try {
      if (!latitude.trim() || !longitude.trim())
        throw new Error("Enter both latitude and longitude.");
      const next = validateReceiverLocation({
        ...(site && !coordinatesEdited
          ? site
          : {
              version: 1,
              source: "manual",
              observedAt: new Date().toISOString(),
            }),
        latitude: Number(latitude),
        longitude: Number(longitude),
        label: label.trim() || undefined,
      });
      apply(next);
      setMessage("Antenna site applied for future acquisitions.");
      setOpen(false);
    } catch (error) {
      setMessage((error as Error).message);
    }
  };
  const locate = () => {
    cancel();
    if (!window.isSecureContext || !navigator.geolocation) {
      setMessage(
        "Browser location is unavailable here. Enter the antenna coordinates manually.",
      );
      return;
    }
    const generation = ++request.current.generation;
    setPending(true);
    setMessage("Waiting for location permission or a fix…");
    const finish = (text: string) => {
      clearTimeout(deadline.current);
      setPending(false);
      setMessage(text);
    };
    deadline.current = setTimeout(() => {
      if (generation !== request.current.generation) return;
      request.current.generation++;
      finish("Location request timed out. The previous site is retained.");
    }, 20_000);
    try {
      navigator.geolocation.getCurrentPosition(
        (position) => {
          if (generation !== request.current.generation) return;
          request.current.generation++;
          try {
            apply({
              ...locationFromBrowser(position),
              ...(label.trim() ? { label: label.trim() } : {}),
            });
            finish("Browser fix applied. Confirm antenna/device co-location.");
          } catch (error) {
            finish(
              (error as Error).message + " The previous site is retained.",
            );
          }
        },
        (error) => {
          if (generation !== request.current.generation) return;
          request.current.generation++;
          finish(
            error.code === 1
              ? "Location permission denied. The previous site is retained; manual entry is available."
              : error.code === 3
                ? "Location request timed out. The previous site is retained."
                : "Location fix unavailable. The previous site is retained.",
          );
        },
        { enableHighAccuracy: true, maximumAge: 0, timeout: 15_000 },
      );
    } catch {
      request.current.generation++;
      finish("Browser location is unavailable. The previous site is retained.");
    }
  };
  const stale = Boolean(site && locationIsStale(site, now));
  return (
    <div className="antenna-site">
      <button
        ref={trigger}
        type="button"
        className="secondary workspace-tool-trigger antenna-site-trigger"
        aria-label="Antenna site"
        aria-describedby={`${id}-summary`}
        aria-haspopup="dialog"
        aria-controls={id}
        aria-expanded={open}
        onClick={() => setOpen(true)}
      >
        <AppIcon name="pin" />
        <span>
          <strong>Antenna site</strong>
          <small
            id={`${id}-summary`}
            className={`antenna-site-summary${stale ? " is-stale" : ""}`}
            role="status"
          >
            {site
              ? `${site.label || "Site set"} · ${stale ? "Stale fix" : site.source === "browser" ? "Browser fix" : site.source === "imported" ? "Imported" : "Manual"}`
              : "Not set · optional"}
          </small>
        </span>
        <span aria-hidden="true">›</span>
      </button>
      {!open && storageError && (
        <p className="antenna-site-storage" role="alert">
          {storageError}
        </p>
      )}
      {createPortal(
        <dialog
          ref={dialog}
          id={id}
          className="antenna-site-panel overlay-motion"
          aria-labelledby={`${id}-heading`}
          aria-describedby={`${id}-context`}
          onCancel={(event) => {
            event.preventDefault();
            dismiss();
          }}
          onClick={(event) => {
            if (event.target !== event.currentTarget) return;
            const bounds = event.currentTarget.getBoundingClientRect();
            if (
              event.clientX < bounds.left ||
              event.clientX > bounds.right ||
              event.clientY < bounds.top ||
              event.clientY > bounds.bottom
            )
              dismiss();
          }}
          onKeyDown={(event) => {
            if (event.key !== "Tab") return;
            const controls = Array.from(
              event.currentTarget.querySelectorAll<HTMLElement>(
                "button:not(:disabled), input:not(:disabled), summary, a[href]",
              ),
            ).filter((element) => element.getClientRects().length > 0);
            const first = controls[0],
              last = controls.at(-1);
            const active = event.currentTarget.ownerDocument.activeElement;
            if (event.shiftKey && active === first && last) {
              event.preventDefault();
              last.focus();
            } else if (!event.shiftKey && active === last && first) {
              event.preventDefault();
              first.focus();
            }
          }}
        >
          <header className="favorites-heading">
            <div>
              <h3 id={`${id}-heading`}>Antenna site</h3>
              <p id={`${id}-context`}>
                {remote
                  ? "Remote receiver · confirmed antenna and band"
                  : "Local receiver · future recordings"}
              </p>
            </div>
            <button
              type="button"
              className="secondary"
              aria-label="Close antenna site"
              onClick={dismiss}
            >
              <AppIcon name="close" />
            </button>
          </header>
          <div className="favorites-body antenna-site-body">
            {!remote && (
              <div className="antenna-site-location-method">
                <button
                  type="button"
                  className="secondary"
                  disabled={pending}
                  onClick={locate}
                >
                  <AppIcon name="locate" /> Use my location
                </button>
                <p>Use this device if it is beside the receiving antenna.</p>
                {pending && (
                  <button
                    type="button"
                    className="secondary"
                    onClick={() => {
                      cancel();
                      setMessage(
                        "Request cancelled. The previous site is retained.",
                      );
                    }}
                  >
                    Cancel location request
                  </button>
                )}
              </div>
            )}
            {remote && (
              <p>
                Manually supplied coordinates for this remote antenna and
                confirmed band. Your device location is not used.
              </p>
            )}
            <label>
              Site name
              <input
                name="site-name"
                value={label}
                maxLength={120}
                placeholder="Optional site name"
                onChange={(e) => setLabel(e.currentTarget.value)}
              />
            </label>
            <div className="antenna-site-coordinates">
              <label>
                Latitude
                <input
                  type="number"
                  aria-label="Latitude"
                  min="-90"
                  max="90"
                  step="any"
                  value={latitude}
                  onChange={(e) => {
                    setLatitude(e.currentTarget.value);
                    setCoordinatesEdited(true);
                  }}
                />
                <small>WGS84 · decimal degrees</small>
              </label>
              <label>
                Longitude
                <input
                  type="number"
                  aria-label="Longitude"
                  min="-180"
                  max="180"
                  step="any"
                  value={longitude}
                  onChange={(e) => {
                    setLongitude(e.currentTarget.value);
                    setCoordinatesEdited(true);
                  }}
                />
                <small>WGS84 · decimal degrees</small>
              </label>
            </div>
            <div className="antenna-site-status" role="status">
              {site ? (
                <>
                  <strong>
                    {site.source === "browser"
                      ? "Browser fix"
                      : site.source === "imported"
                        ? "Imported site"
                        : "Manual entry"}
                  </strong>
                  <p>{`${site.latitude}, ${site.longitude} · ${site.source} · ${site.accuracyMeters === undefined ? "accuracy unknown" : `reported accuracy ±${site.accuracyMeters} m`}`}</p>
                  <p>
                    {site.observedAt
                      ? `${site.source === "browser" ? "fix" : "entered"} ${site.observedAt}`
                      : "fix time unknown"}
                  </p>
                  {stale && (
                    <p className="antenna-site-stale">
                      <AppIcon name="alert" /> stale fix (over 5 minutes);
                      refresh before moving-site capture
                    </p>
                  )}
                </>
              ) : (
                "Antenna location unknown."
              )}
            </div>
            <label className="antenna-site-remember">
              <input
                type="checkbox"
                disabled={pending}
                checked={remembered}
                onChange={(e) => change(site, e.currentTarget.checked)}
              />
              <span>
                Remember exact site in this browser
                <small>Otherwise, keep it for this tab only.</small>
              </span>
            </label>
            <details className="antenna-site-usage">
              <summary>How this site is used</summary>
              <p>
                {remote
                  ? "Remote presets and tuning links omit this site. Operator GPS/catalog coordinates are not imported automatically."
                  : "New recording and survey exports include the selected site. Tuning links and Favorites omit it. No background tracking. Future captures only."}
              </p>
              <p>Reception site, not transmitter position.</p>
            </details>
            {(message || storageError) && (
              <p role="status">{storageError || message}</p>
            )}
          </div>
          <footer className="favorites-footer antenna-site-footer">
            {site && (
              <button
                type="button"
                className="secondary antenna-site-clear"
                onClick={() => {
                  cancel();
                  change(undefined, false);
                  setLatitude("");
                  setLongitude("");
                  setLabel("");
                  setCoordinatesEdited(false);
                  setMessage("Site cleared for future acquisitions.");
                }}
              >
                Clear site
              </button>
            )}
            <div>
              <button type="button" className="secondary" onClick={dismiss}>
                Cancel
              </button>
              <button type="button" onClick={save}>
                Apply site
              </button>
            </div>
          </footer>
        </dialog>,
        document.body,
      )}
    </div>
  );
}
export function RemoteLocationPanel({ scope }: { scope: string }) {
  const value = useReceiverLocation(scope);
  return <ReceiverLocationPanel value={value} remote />;
}

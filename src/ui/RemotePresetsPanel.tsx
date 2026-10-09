import { useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { AppIcon } from "./AppIcon";
import {
  REMOTE_PRESET_KEY,
  MAX_REMOTE_PRESET_BYTES,
  exportRemotePresets,
  importRemotePresets,
  mergeRemotePresets,
  validateRemotePreset,
  createRemoteShareUrl,
  type RemotePreset,
} from "../remote/remotePresets";
import { REMOTE_MODES } from "../remote/openWebRxProtocol";
import { KIWI_MODES } from "../remote/kiwiProtocol";

function readSaved() {
  let saved: string | null;
  try {
    saved = localStorage.getItem(REMOTE_PRESET_KEY);
  } catch {
    return {
      items: [] as RemotePreset[],
      corrupt: false,
      message:
        "Storage is unavailable. Export a backup before closing this tab.",
    };
  }
  try {
    return {
      items: saved ? importRemotePresets(saved) : [],
      corrupt: false,
      message: "",
    };
  } catch {
    return {
      items: [] as RemotePreset[],
      corrupt: true,
      message:
        "Saved remote favorites could not be read. The original data is preserved; import a valid backup to restore editing.",
    };
  }
}
export function useRemotePresets() {
  const [state, setState] = useState(readSaved);
  const latest = useRef(state);
  latest.current = state;
  const change = (
    update: (items: RemotePreset[]) => RemotePreset[],
    restore = false,
  ) => {
    if (latest.current.corrupt && !restore)
      throw new Error(latest.current.message);
    const items = importRemotePresets(
      exportRemotePresets(update(latest.current.items)),
    );
    let message = "";
    try {
      localStorage.setItem(REMOTE_PRESET_KEY, exportRemotePresets(items));
    } catch {
      message =
        "Remote favorites are available in this tab; storage failed. Export a backup before closing it.";
    }
    const next = { items, message, corrupt: false };
    latest.current = next;
    setState(next);
  };
  useEffect(() => {
    const sync = (event: StorageEvent) => {
      if (event.key === REMOTE_PRESET_KEY || event.key === null) {
        const next = readSaved();
        latest.current = next;
        setState(next);
      }
    };
    window.addEventListener("storage", sync);
    return () => window.removeEventListener("storage", sync);
  }, []);
  return { ...state, change };
}
type PresetDraft = Omit<RemotePreset, "id" | "name" | "notes">;
export function RemotePresetsPanel({
  library,
  receiver,
  channel,
  onLoad,
}: {
  library: ReturnType<typeof useRemotePresets>;
  receiver: PresetDraft;
  channel?: () => PresetDraft;
  onLoad: (preset: RemotePreset) => void;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [draft, setDraft] = useState<RemotePreset>();
  const [message, setMessage] = useState("");
  const [link, setLink] = useState("");
  const [remove, setRemove] = useState("");
  const dialog = useRef<HTMLDialogElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const file = useRef<HTMLInputElement>(null);
  const linkInput = useRef<HTMLTextAreaElement>(null);
  const editingBase = useRef<string | undefined>(undefined);
  const id = useId();
  const editing = Boolean(draft);
  useEffect(() => {
    const panel = dialog.current;
    if (!panel) return;
    if (open) {
      if (!panel.open) panel.showModal();
      panel
        .querySelector<HTMLInputElement>(
          editing ? ".remote-preset-editor input" : 'input[type="search"]',
        )
        ?.focus();
    } else if (panel.open) {
      panel.close();
      trigger.current?.focus();
    }
  }, [open, editing]);
  const perform = (action: () => void, success = "") => {
    try {
      action();
      setMessage(success);
    } catch (reason) {
      setMessage(
        reason instanceof Error
          ? reason.message
          : "Remote favorite action failed.",
      );
    }
  };
  const makeDraft = (value: PresetDraft) => {
    editingBase.current = undefined;
    setDraft({
      ...value,
      id: crypto.randomUUID(),
      name: value.tune
        ? `${value.tune.frequency / 1e6} MHz · ${REMOTE_MODES[value.tune.mode]}`
        : value.kind === "kiwi"
          ? "KiwiSDR receiver"
          : "OpenWebRX receiver",
      notes: "",
    });
  };
  const copyLink = async () => {
    try {
      await navigator.clipboard.writeText(link);
      setMessage("Link copied.");
    } catch {
      linkInput.current?.focus();
      linkInput.current?.select();
      setMessage("Select and copy the link.");
    }
  };
  const backup = () =>
    perform(() => {
      const url = URL.createObjectURL(
        new Blob([exportRemotePresets(library.items)], {
          type: "application/json",
        }),
      );
      const a = document.createElement("a");
      a.href = url;
      a.download = "browsersdr-remote-favorites.json";
      document.body.append(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    }, "Remote backup downloaded.");
  const importFile = async (selected: File) => {
    try {
      if (selected.size > MAX_REMOTE_PRESET_BYTES)
        throw new Error("Remote backup exceeds 256 KiB.");
      const incoming = importRemotePresets(await selected.text());
      library.change((items) => mergeRemotePresets(items, incoming), true);
      setMessage(
        "Remote backup imported. Existing entries retained; identical IDs skipped.",
      );
    } catch (reason) {
      setMessage(
        reason instanceof Error
          ? reason.message
          : "Could not import the remote backup.",
      );
    }
  };
  const shown = library.items.filter((item) =>
    `${item.name} ${item.address} ${item.notes} ${item.kind} ${item.tune ? `${item.tune.frequency / 1e6} ${REMOTE_MODES[item.tune.mode]}` : ""}`
      .toLowerCase()
      .includes(query.trim().toLowerCase()),
  );
  return (
    <>
      <button
        ref={trigger}
        type="button"
        className="secondary remote-favorites-trigger"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={id}
        onClick={() => setOpen(true)}
      >
        <AppIcon name="star" /> Remote favorites{" "}
        <span>{library.items.length}</span>
        {library.message && <AppIcon name="alert" />}
      </button>
      {library.message && (
        <span className="favorite-storage-warning" role="status">
          {library.message}
        </span>
      )}
      {createPortal(
        <dialog
          ref={dialog}
          id={id}
          className="favorites-panel remote-presets-panel"
          aria-labelledby={`${id}-heading`}
          onCancel={(e) => {
            e.preventDefault();
            setOpen(false);
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
              setOpen(false);
          }}
          onKeyDown={(e) => {
            if (e.key !== "Tab") return;
            const controls = [
              ...e.currentTarget.querySelectorAll<HTMLElement>(
                "button:not(:disabled), input:not(:disabled), textarea, select, summary, a[href]",
              ),
            ].filter((el) => el.getClientRects().length);
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
          <header className="favorites-heading">
            <div>
              <h3 id={`${id}-heading`}>Remote favorites</h3>
              <p>{library.items.length} saved · in this browser</p>
            </div>
            <button
              type="button"
              className="secondary"
              aria-label="Close Remote favorites"
              onClick={() => setOpen(false)}
            >
              <AppIcon name="close" />
            </button>
          </header>
          <div className="favorites-body">
            <p className="display-note">
              Load disconnects the current remote stream. Connect and Listen
              stay manual. These presets are separate from local Favorites.
            </p>
            {library.message && <p role="alert">{library.message}</p>}
            {!draft && (
              <div className="favorites-search-row">
                <label>
                  Search remote favorites
                  <input
                    type="search"
                    value={query}
                    onChange={(e) => setQuery(e.currentTarget.value)}
                  />
                </label>
                <button
                  type="button"
                  className="secondary"
                  disabled={library.corrupt}
                  onClick={() => perform(() => makeDraft(receiver))}
                >
                  Save receiver
                </button>
                <button
                  type="button"
                  className="secondary"
                  disabled={!channel || library.corrupt}
                  onClick={() =>
                    perform(() => {
                      if (channel) makeDraft(channel());
                    })
                  }
                >
                  Save channel preset
                </button>
              </div>
            )}
            {draft ? (
              <div className="remote-preset-editor favorite-editor">
                <label className="favorite-wide-field">
                  Preset name
                  <input
                    value={draft.name}
                    maxLength={80}
                    onChange={(e) =>
                      setDraft({ ...draft, name: e.currentTarget.value })
                    }
                  />
                </label>
                <label className="favorite-wide-field">
                  Saved receiver website
                  <input
                    type="url"
                    value={draft.address}
                    maxLength={2048}
                    onChange={(e) =>
                      setDraft({ ...draft, address: e.currentTarget.value })
                    }
                  />
                </label>
                <label className="favorite-wide-field">
                  Notes
                  <input
                    value={draft.notes}
                    maxLength={2048}
                    onChange={(e) =>
                      setDraft({ ...draft, notes: e.currentTarget.value })
                    }
                  />
                </label>
                <p className="favorite-wide-field display-note">
                  {draft.tune &&
                    "Edit requested settings below; receiver compatibility is checked after Connect. "}
                  {draft.kind === "kiwi" ? "KiwiSDR" : "OpenWebRX"}
                  {draft.tune
                    ? ` · ${draft.tune.frequency / 1e6} MHz · ${REMOTE_MODES[draft.tune.mode]} · filter ${draft.tune.lowCut}…${draft.tune.highCut} Hz`
                    : " · receiver only"}
                  . Channel values are requested settings, not received
                  evidence.
                </p>
                {draft.tune && (
                  <>
                    <label>
                      Saved channel · MHz
                      <input
                        inputMode="decimal"
                        value={
                          Number.isFinite(draft.tune.frequency)
                            ? draft.tune.frequency / 1e6
                            : ""
                        }
                        onChange={(e) =>
                          setDraft({
                            ...draft,
                            tune: {
                              ...draft.tune!,
                              frequency: e.currentTarget.value.trim()
                                ? Math.round(
                                    Number(e.currentTarget.value) * 1e6,
                                  )
                                : NaN,
                            },
                          })
                        }
                      />
                    </label>
                    <label>
                      Saved mode
                      <select
                        value={draft.tune.mode}
                        onChange={(e) =>
                          setDraft({
                            ...draft,
                            tune: {
                              ...draft.tune!,
                              mode: e.currentTarget
                                .value as keyof typeof REMOTE_MODES,
                            },
                          })
                        }
                      >
                        {(draft.kind === "kiwi"
                          ? KIWI_MODES
                          : (Object.keys(
                              REMOTE_MODES,
                            ) as (keyof typeof REMOTE_MODES)[])
                        ).map((mode) => (
                          <option key={mode} value={mode}>
                            {REMOTE_MODES[mode]}
                          </option>
                        ))}
                      </select>
                    </label>
                    {(["lowCut", "highCut", "squelch"] as const)
                      .filter(
                        (key) => draft.kind !== "kiwi" || key !== "squelch",
                      )
                      .map((key) => (
                        <label key={key}>
                          {key === "lowCut"
                            ? "Saved low cut · Hz"
                            : key === "highCut"
                              ? "Saved high cut · Hz"
                              : "Saved squelch"}
                          <input
                            type="number"
                            value={
                              Number.isFinite(draft.tune![key])
                                ? draft.tune![key]
                                : ""
                            }
                            onChange={(e) =>
                              setDraft({
                                ...draft,
                                tune: {
                                  ...draft.tune!,
                                  [key]: e.currentTarget.value.trim()
                                    ? Number(e.currentTarget.value)
                                    : NaN,
                                },
                              })
                            }
                          />
                        </label>
                      ))}
                    {draft.kind === "kiwi" ? (
                      <label>
                        Saved waterfall zoom
                        <select
                          value={draft.zoom ?? 0}
                          onChange={(e) =>
                            setDraft({
                              ...draft,
                              zoom: Number(e.currentTarget.value),
                            })
                          }
                        >
                          {Array.from({ length: 15 }, (_, zoom) => (
                            <option key={zoom} value={zoom}>
                              {zoom === 0 ? "Full band" : `${2 ** zoom}×`}
                            </option>
                          ))}
                        </select>
                      </label>
                    ) : (
                      <label className="favorite-wide-field">
                        Saved receiver band
                        <input
                          value={draft.profile ?? ""}
                          maxLength={320}
                          onChange={(e) =>
                            setDraft({
                              ...draft,
                              profile: e.currentTarget.value || undefined,
                            })
                          }
                        />
                      </label>
                    )}
                  </>
                )}
                <button
                  type="button"
                  disabled={library.corrupt}
                  onClick={() =>
                    perform(() => {
                      const item = validateRemotePreset(draft);
                      library.change((items) => {
                        if (
                          editingBase.current !== undefined &&
                          JSON.stringify(
                            items.find((old) => old.id === item.id),
                          ) !== editingBase.current
                        )
                          throw new Error(
                            "This favorite changed in another tab. Cancel and reopen it before editing.",
                          );
                        return items.some((old) => old.id === item.id)
                          ? items.map((old) =>
                              old.id === item.id ? item : old,
                            )
                          : [...items, item];
                      });
                      setDraft(undefined);
                    }, "Remote favorite saved.")
                  }
                >
                  Save remote favorite
                </button>
                <button
                  type="button"
                  className="secondary"
                  onClick={() => setDraft(undefined)}
                >
                  Cancel edit
                </button>
              </div>
            ) : (
              <ul className="favorites-list">
                {shown.map((item) => (
                  <li key={item.id}>
                    <div className="favorite-summary">
                      <strong>{item.name}</strong>
                      <span>
                        {item.kind === "kiwi" ? "KiwiSDR" : "OpenWebRX"}
                        {item.tune
                          ? ` · ${item.tune.frequency / 1e6} MHz · ${REMOTE_MODES[item.tune.mode]}`
                          : " · receiver only"}
                      </span>
                      <small>{item.address}</small>
                    </div>
                    <div className="favorite-actions">
                      <button
                        type="button"
                        onClick={() =>
                          perform(() => {
                            onLoad(item);
                            setOpen(false);
                          })
                        }
                      >
                        Load
                      </button>
                      <button
                        type="button"
                        className="secondary"
                        onClick={() => {
                          editingBase.current = JSON.stringify(item);
                          setDraft({ ...item });
                          setLink("");
                        }}
                      >
                        Edit
                      </button>
                      <button
                        type="button"
                        className="secondary"
                        onClick={() =>
                          perform(
                            () =>
                              setLink(
                                createRemoteShareUrl(location.href, item),
                              ),
                            "Preset link prepared; local notes and collection IDs are excluded.",
                          )
                        }
                      >
                        Share preset
                      </button>
                      <button
                        type="button"
                        className="secondary"
                        disabled={library.corrupt}
                        onClick={() =>
                          remove === item.id
                            ? perform(() => {
                                library.change((items) =>
                                  items.filter((old) => old.id !== item.id),
                                );
                                setRemove("");
                              }, "Remote favorite removed.")
                            : setRemove(item.id)
                        }
                      >
                        {remove === item.id ? "Confirm removal" : "Remove"}
                      </button>
                    </div>
                    {item.notes && (
                      <details>
                        <summary>Notes</summary>
                        <p>{item.notes}</p>
                      </details>
                    )}
                  </li>
                ))}
              </ul>
            )}
            {!draft && !shown.length && (
              <p className="display-note">
                {library.items.length
                  ? "No matching remote favorites."
                  : "Save a receiver address, or connect to save a channel preset."}
              </p>
            )}
            {link && (
              <div className="remote-preset-link">
                <label>
                  Remote preset link
                  <textarea
                    ref={linkInput}
                    aria-label="Remote preset link"
                    rows={3}
                    readOnly
                    value={link}
                    onFocus={(e) => e.currentTarget.select()}
                  />
                </label>
                <button
                  type="button"
                  className="secondary"
                  onClick={() => void copyLink()}
                >
                  Copy remote link
                </button>
                {/^(localhost|127\.|\[::1\]$)/.test(new URL(link).hostname) && (
                  <p className="display-note">
                    This local link works on this computer. Create links on the
                    published site to share with others.
                  </p>
                )}
              </div>
            )}
          </div>
          <footer className="favorites-footer">
            <div className="favorite-actions">
              <button
                type="button"
                className="secondary"
                disabled={library.corrupt}
                onClick={backup}
              >
                Export remote backup
              </button>
              <button
                type="button"
                className="secondary"
                onClick={() => file.current?.click()}
              >
                Import remote backup
              </button>
              <input
                ref={file}
                type="file"
                accept=".json,application/json"
                hidden
                onChange={(e) => {
                  const selected = e.currentTarget.files?.[0];
                  e.currentTarget.value = "";
                  if (selected) void importFile(selected);
                }}
              />
            </div>
            <p role="status">{message}</p>
          </footer>
        </dialog>,
        document.body,
      )}
    </>
  );
}

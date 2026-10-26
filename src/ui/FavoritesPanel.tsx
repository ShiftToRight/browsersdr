import { InstrumentButton } from "./InstrumentButton";
import { useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { AppIcon } from "./AppIcon";
import { useOverlayDialog } from "./useOverlayDialog";
import {
  MAX_BOOKMARK_BYTES,
  exportBookmarks,
  importBookmarks,
  mergeBookmarks,
  validateBookmark,
  type Bookmark,
} from "../radio/bookmarks";
import { defaultModeSettings, RECEIVER_MODES } from "../radio/receiverConfig";
import { atlasStationUrl } from "../radio/atlasStationNavigation";

export { useFavorites } from "./useFavorites";

export function FavoritesPanel({
  initialOpen = false,
  items,
  storageMessage,
  draft,
  onNew,
  onEdit,
  onCancel,
  onChange,
  onRecall,
  blockedReason,
  saveBlockedReason,
}: {
  initialOpen?: boolean;
  items: Bookmark[];
  storageMessage: string;
  draft?: Bookmark;
  onNew: () => void;
  onEdit: (item: Bookmark) => void;
  onCancel: () => void;
  onChange: (
    update: (items: Bookmark[]) => Bookmark[],
    restore?: boolean,
  ) => void;
  onRecall: (item: Bookmark) => Promise<string>;
  blockedReason?: string;
  saveBlockedReason?: string;
}) {
  const [query, setQuery] = useState("");
  const [message, setMessage] = useState("");
  const [recalling, setRecalling] = useState(false);
  const file = useRef<HTMLInputElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const dialog = useRef<HTMLDialogElement>(null);
  const dialogId = useId();
  const [open, setOpen] = useState(initialOpen);
  useEffect(() => {
    if (draft) setOpen(true);
  }, [draft]);
  useOverlayDialog(
    open,
    dialog,
    trigger,
    draft ? ".favorite-editor input" : 'input[type="search"]',
  );
  const perform = (action: () => void, result: string) => {
    try {
      action();
      setMessage(result);
    } catch (error) {
      setMessage(
        error instanceof Error ? error.message : "Favorite action failed.",
      );
    }
  };
  const exportBackup = () =>
    perform(() => {
      const url = URL.createObjectURL(
        new Blob([exportBookmarks(items)], { type: "application/json" }),
      );
      const link = document.createElement("a");
      link.href = url;
      link.download = "browsersdr-favorites.json";
      document.body.append(link);
      link.click();
      link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    }, "Favorite backup downloaded. It contains tuning settings and notes; no tokens or recording data.");
  const importBackup = async (selected: File) => {
    try {
      if (selected.size > MAX_BOOKMARK_BYTES)
        throw new Error("Favorite backup exceeds 256 KiB.");
      const incoming = importBookmarks(await selected.text());
      onChange((current) => mergeBookmarks(current, incoming), true);
      setMessage(
        "Backup imported. Existing favorites retained; identical IDs are skipped. Reception is unchanged.",
      );
    } catch (error) {
      setMessage(
        error instanceof Error ? error.message : "Could not import favorites.",
      );
    }
  };
  const shown = items.filter((item) =>
    `${item.name} ${item.tags.join(" ")} ${item.notes} ${item.frequencyHz / 1e6} ${item.settings.mode}`
      .toLowerCase()
      .includes(query.trim().toLowerCase()),
  );
  return (
    <>
      <InstrumentButton
        ref={trigger}
        type="button"
        className="favorites-trigger secondary"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={dialogId}
        onClick={() => setOpen(true)}
      >
        <AppIcon name="star" /> Favorites <span>{items.length}</span>
        {storageMessage && <AppIcon name="alert" />}
      </InstrumentButton>
      {!open && storageMessage && (
        <p className="favorite-storage-warning" role="alert">
          {storageMessage}
        </p>
      )}
      {!open && message && (
        <span className="visually-hidden" role="status">
          {message}
        </span>
      )}
      {createPortal(
        <dialog
          ref={dialog}
          id={dialogId}
          className="favorites-panel overlay-motion"
          aria-labelledby={`${dialogId}-heading`}
          aria-describedby={`${dialogId}-help`}
          onCancel={(event) => {
            event.preventDefault();
            setOpen(false);
          }}
          onKeyDown={(event) => {
            if (event.key !== "Tab") return;
            const controls = Array.from(
              event.currentTarget.querySelectorAll<HTMLElement>(
                "button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), summary, a[href]",
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
          onClick={(event) => {
            if (event.target !== event.currentTarget) return;
            const bounds = event.currentTarget.getBoundingClientRect();
            if (
              event.clientX < bounds.left ||
              event.clientX > bounds.right ||
              event.clientY < bounds.top ||
              event.clientY > bounds.bottom
            )
              setOpen(false);
          }}
        >
          <header className="favorites-heading">
            <div>
              <h3 id={`${dialogId}-heading`}>Favorites</h3>
              <p>{items.length} saved · in this browser</p>
            </div>
            <InstrumentButton
              type="button"
              className="secondary"
              aria-label="Close Favorites"
              onClick={() => setOpen(false)}
            >
              <AppIcon name="close" />
            </InstrumentButton>
          </header>
          <div className="favorites-body">
            <p
              id={`${dialogId}-help`}
              className="display-note favorites-guidance"
            >
              Recall keeps your source and never starts reception.
            </p>
            <div className="favorites-search-row" hidden={Boolean(draft)}>
              <label>
                Search favorites
                <input
                  type="search"
                  value={query}
                  maxLength={200}
                  onChange={(event) => setQuery(event.currentTarget.value)}
                  placeholder="Name, frequency or tag"
                />
              </label>
              <InstrumentButton
                type="button"
                aria-label="Save current channel"
                disabled={Boolean(saveBlockedReason)}
                title={saveBlockedReason}
                onClick={() => {
                  setMessage("");
                  onNew();
                }}
              >
                <AppIcon name="plus" /> Save current
              </InstrumentButton>
              {saveBlockedReason && (
                <p className="display-note">{saveBlockedReason}</p>
              )}
            </div>
            {draft && (
              <FavoriteEditor
                key={draft.id}
                draft={draft}
                onCancel={onCancel}
                onSave={(item) =>
                  perform(() => {
                    onChange((current) =>
                      current.some((old) => old.id === item.id)
                        ? current.map((old) =>
                            old.id === item.id ? item : old,
                          )
                        : [...current, item],
                    );
                    onCancel();
                  }, "Favorite saved.")
                }
              />
            )}
            <div className="favorites-collection" hidden={Boolean(draft)}>
              {shown.length === 0 && (
                <p className="display-note">
                  {items.length ? "No favorites match." : "No favorites yet."}
                </p>
              )}
              <ul className="favorites-list">
                {shown.map((item) => {
                  const index = items.indexOf(item);
                  let atlasLink: string | undefined;
                  try {
                    if (item.atlasReference?.station_id)
                      atlasLink = atlasStationUrl(
                        item.atlasReference.station_id,
                        item.atlasReference.transmission_id,
                      );
                  } catch {
                    /* Atlas configuration is optional. */
                  }
                  return (
                    <li key={item.id} aria-label={item.name}>
                      <div className="favorite-row">
                        <div className="favorite-summary">
                          <strong>{item.name}</strong>
                          <span>
                            {item.frequencyHz / 1e6} MHz · {item.settings.mode}{" "}
                            · {item.settings.bandwidthHz.toLocaleString()} Hz
                          </span>
                        </div>
                        <div className="favorite-actions">
                          <InstrumentButton
                            type="button"
                            disabled={recalling || Boolean(blockedReason)}
                            title={blockedReason}
                            aria-label={`Recall ${item.name}`}
                            onClick={() => {
                              setRecalling(true);
                              setMessage("");
                              void onRecall(item)
                                .then(
                                  (result) => {
                                    setMessage(result);
                                    setOpen(false);
                                  },
                                  (error: unknown) =>
                                    setMessage(
                                      error instanceof Error
                                        ? error.message
                                        : "Could not recall favorite.",
                                    ),
                                )
                                .finally(() => setRecalling(false));
                            }}
                          >
                            Recall
                          </InstrumentButton>
                          <InstrumentButton
                            type="button"
                            className="secondary"
                            onClick={() => {
                              onEdit(item);
                              setMessage("");
                            }}
                          >
                            Edit
                          </InstrumentButton>
                        </div>
                      </div>
                      <details className="favorite-details">
                        <summary>
                          Details &amp; order
                          <span className="visually-hidden">
                            {" "}
                            for {item.name}
                          </span>
                        </summary>
                        {item.tags.length > 0 && (
                          <small>{item.tags.join(" · ")}</small>
                        )}
                        {item.notes && <p>{item.notes}</p>}
                        {item.sourceHint && (
                          <small>
                            Saved with {item.sourceHint}; uses your current
                            source.
                          </small>
                        )}
                        {item.atlasReference && (
                          <small>
                            Saved Atlas reference · not rechecked · station
                            identity unconfirmed.{" "}
                            {atlasLink && (
                              <a
                                href={atlasLink}
                                target="_blank"
                                rel="noopener noreferrer"
                              >
                                Open reference
                              </a>
                            )}
                          </small>
                        )}
                        <div className="favorite-actions">
                          <InstrumentButton
                            type="button"
                            className="secondary"
                            aria-label={`Move ${item.name} up`}
                            disabled={index === 0}
                            onClick={() =>
                              perform(
                                () =>
                                  onChange((current) => {
                                    const result = [...current],
                                      from = result.findIndex(
                                        (row) => row.id === item.id,
                                      );
                                    if (from > 0)
                                      [result[from - 1], result[from]] = [
                                        result[from]!,
                                        result[from - 1]!,
                                      ];
                                    return result;
                                  }),
                                "Favorite order saved.",
                              )
                            }
                          >
                            ↑
                          </InstrumentButton>
                          <InstrumentButton
                            type="button"
                            className="secondary"
                            aria-label={`Move ${item.name} down`}
                            disabled={index === items.length - 1}
                            onClick={() =>
                              perform(
                                () =>
                                  onChange((current) => {
                                    const result = [...current],
                                      from = result.findIndex(
                                        (row) => row.id === item.id,
                                      );
                                    if (from >= 0 && from < result.length - 1)
                                      [result[from], result[from + 1]] = [
                                        result[from + 1]!,
                                        result[from]!,
                                      ];
                                    return result;
                                  }),
                                "Favorite order saved.",
                              )
                            }
                          >
                            ↓
                          </InstrumentButton>
                          <InstrumentButton
                            type="button"
                            className="secondary"
                            aria-label={`Delete ${item.name}`}
                            onClick={() =>
                              perform(
                                () =>
                                  onChange((current) =>
                                    current.filter((old) => old.id !== item.id),
                                  ),
                                "Favorite deleted.",
                              )
                            }
                          >
                            Delete
                          </InstrumentButton>
                        </div>
                      </details>
                    </li>
                  );
                })}
              </ul>
              {blockedReason && <p className="display-note">{blockedReason}</p>}
            </div>
          </div>
          <footer className="favorites-footer">
            <div
              className="favorite-actions favorites-backup"
              hidden={Boolean(draft)}
            >
              <InstrumentButton
                type="button"
                className="secondary"
                onClick={exportBackup}
                disabled={!items.length}
              >
                Export favorites
              </InstrumentButton>
              <InstrumentButton
                type="button"
                className="secondary"
                onClick={() => file.current?.click()}
              >
                Import favorites
              </InstrumentButton>
              <input
                ref={file}
                hidden
                aria-label="Favorite backup file"
                type="file"
                accept=".json,application/json"
                onChange={(event) => {
                  const selected = event.currentTarget.files?.[0];
                  event.currentTarget.value = "";
                  if (selected) void importBackup(selected);
                }}
              />
            </div>
            {storageMessage && <p role="alert">{storageMessage}</p>}
            {message && <p role="status">{message}</p>}
          </footer>
        </dialog>,
        document.body,
      )}
    </>
  );
}
function FavoriteEditor({
  draft,
  onSave,
  onCancel,
}: {
  draft: Bookmark;
  onSave: (item: Bookmark) => void;
  onCancel: () => void;
}) {
  const [item, setItem] = useState(() => structuredClone(draft));
  const [tags, setTags] = useState(draft.tags.join(", "));
  const [frequency, setFrequency] = useState(String(draft.frequencyHz / 1e6));
  const [error, setError] = useState("");
  return (
    <form
      className="favorite-editor"
      aria-label="Favorite editor"
      onSubmit={(event) => {
        event.preventDefault();
        try {
          const changedTuning =
            Number(frequency) * 1e6 !== draft.frequencyHz ||
            item.settings.mode !== draft.settings.mode;
          onSave(
            validateBookmark({
              ...item,
              frequencyHz: Math.round(Number(frequency) * 1e6),
              tags: tags
                .split(",")
                .map((tag) => tag.trim())
                .filter(Boolean),
              ...(changedTuning ? { atlasReference: undefined } : {}),
            }),
          );
        } catch (cause) {
          setError(
            cause instanceof Error ? cause.message : "Invalid favorite.",
          );
        }
      }}
    >
      <label>
        Favorite name
        <input
          autoFocus
          required
          maxLength={100}
          value={item.name}
          onChange={(event) =>
            setItem({ ...item, name: event.currentTarget.value })
          }
        />
      </label>
      <label>
        Favorite frequency (MHz)
        <input
          type="number"
          required
          min={0.000001}
          max={6000}
          step="0.000001"
          value={frequency}
          onChange={(event) => setFrequency(event.currentTarget.value)}
        />
      </label>
      <label>
        Favorite mode
        <select
          value={item.settings.mode}
          onChange={(event) =>
            setItem({
              ...item,
              settings: defaultModeSettings(
                event.currentTarget.value as Bookmark["settings"]["mode"],
              ),
            })
          }
        >
          {RECEIVER_MODES.map((mode) => (
            <option key={mode}>{mode}</option>
          ))}
        </select>
      </label>
      <label>
        Favorite bandwidth (Hz)
        <input
          type="number"
          required
          value={item.settings.bandwidthHz}
          onChange={(event) =>
            setItem({
              ...item,
              settings: {
                ...item.settings,
                bandwidthHz: event.currentTarget.valueAsNumber,
              },
            })
          }
        />
      </label>
      <label>
        Favorite squelch
        <input
          type="number"
          required
          min={0}
          max={6}
          step="0.1"
          value={item.settings.squelch}
          onChange={(event) =>
            setItem({
              ...item,
              settings: {
                ...item.settings,
                squelch: event.currentTarget.valueAsNumber,
              },
            })
          }
        />
      </label>
      {(item.settings.mode === "CW" || item.settings.mode === "CW-TEXT") && (
        <label>
          Favorite beat tone (Hz)
          <input
            type="number"
            required
            min={300}
            max={1000}
            value={item.settings.beatToneHz}
            onChange={(event) =>
              setItem({
                ...item,
                settings: {
                  ...item.settings,
                  beatToneHz: event.currentTarget.valueAsNumber,
                },
              })
            }
          />
        </label>
      )}
      {item.settings.mode === "SRD" && (
        <p className="display-note">
          Saved SRD decoder settings are retained. Save the current channel
          again to capture other SRD settings.
        </p>
      )}
      <label className="favorite-wide-field">
        Tags (comma separated)
        <input
          maxLength={329}
          value={tags}
          onChange={(event) => setTags(event.currentTarget.value)}
        />
      </label>
      <label className="favorite-wide-field">
        Favorite notes
        <textarea
          maxLength={1000}
          value={item.notes}
          onChange={(event) =>
            setItem({ ...item, notes: event.currentTarget.value })
          }
        />
      </label>
      <div className="favorite-actions favorite-wide-field">
        <InstrumentButton type="submit">Save favorite</InstrumentButton>
        <InstrumentButton type="button" className="secondary" onClick={onCancel}>
          Back to favorites
        </InstrumentButton>
      </div>
      {error && <p role="alert">{error}</p>}
    </form>
  );
}

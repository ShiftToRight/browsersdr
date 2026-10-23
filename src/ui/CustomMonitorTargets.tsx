import {
  CUSTOM_TARGET_DRAFT_KEY,
  readPreference,
  storePreference,
} from "./explorerPreferences";
import { useEffect, useState, useId } from "react";
import {
  BOOKMARK_KEY,
  importBookmarks,
  type Bookmark,
} from "../radio/bookmarks";
import {
  frequencyTarget,
  loadWatchlists,
  parseMonitorFrequency,
  saveWatchlists,
  validateMonitorTargets,
  type MonitorTarget,
} from "../radio/customMonitor";

export type MonitorTargetMode =
  "window" | "band-plan" | "frequencies" | "range";
export interface CustomTargetDraft {
  targets?: MonitorTarget[];
  error?: string;
}
interface Entry {
  id: string;
  frequency: string;
  width: string;
  label: string;
}
const entries = (targets: MonitorTarget[]): Entry[] =>
  targets
    .filter((t) => t.kind === "frequency")
    .map((t) => ({
      id: t.id,
      frequency: `${(t.startFrequencyHz + t.endFrequencyHz) / 2} Hz`,
      width: `${t.endFrequencyHz - t.startFrequencyHz} Hz`,
      label: t.label,
    }));
export function CustomMonitorTargets({
  mode,
  disabled,
  currentFrequencyHz,
  seed,
  activeTargets,
  onChange,
}: {
  mode: MonitorTargetMode;
  disabled: boolean;
  currentFrequencyHz?: number;
  seed?: MonitorTarget[];
  activeTargets?: readonly MonitorTarget[];
  onChange: (draft: CustomTargetDraft) => void;
}) {
  const fieldId = useId();
  const fieldError = (value: string) => {
    try {
      if (parseMonitorFrequency(value) <= 0)
        return "Use a positive value with Hz, kHz or MHz.";
      return "";
    } catch {
      return "Enter a frequency with Hz, kHz or MHz.";
    }
  };

  const [saved] = useState(() => readPreference(CUSTOM_TARGET_DRAFT_KEY));
  const text = (key: string, fallback: string) =>
    typeof saved[key] === "string" && saved[key].length <= 200
      ? saved[key]
      : fallback;
  const [rows, setRows] = useState<Entry[]>(() =>
    Array.isArray(saved.rows)
      ? saved.rows
          .filter(
            (v): v is Entry =>
              !!v &&
              typeof v === "object" &&
              ["id", "frequency", "width", "label"].every(
                (k) => typeof v[k] === "string" && v[k].length <= 200,
              ),
          )
          .slice(0, 64)
      : [],
  );
  const [frequency, setFrequency] = useState(() =>
      text("frequency", "99.77 MHz"),
    ),
    [width, setWidth] = useState(() => text("width", "25 kHz")),
    [label, setLabel] = useState(() => text("label", ""));
  const [lower, setLower] = useState(() => text("lower", "99.2 MHz")),
    [upper, setUpper] = useState(() => text("upper", "100.6 MHz"));
  const rangeError = (() => {
    try {
      return parseMonitorFrequency(upper) <= parseMonitorFrequency(lower)
        ? "End must be greater than start."
        : "";
    } catch {
      return "";
    }
  })();
  useEffect(() => {
    storePreference(CUSTOM_TARGET_DRAFT_KEY, {
      rows,
      frequency,
      width,
      label,
      lower,
      upper,
    });
  }, [rows, frequency, width, label, lower, upper]);
  const changedFrequency = (value: string, expected?: number) => {
    if (expected === undefined) return false;
    try {
      return parseMonitorFrequency(value) !== expected;
    } catch {
      return true;
    }
  };
  const [paste, setPaste] = useState("");
  const [notice, setNotice] = useState("");
  const [lists, setLists] = useState(() => {
    try {
      return { items: loadWatchlists(), error: "" };
    } catch (e) {
      return { items: [], error: `Watchlists not loaded: ${String(e)}` };
    }
  });
  const [listId, setListId] = useState(""),
    [listName, setListName] = useState("");
  const [favorites, setFavorites] = useState<Bookmark[]>([]),
    [chosen, setChosen] = useState<Set<string>>(new Set());
  useEffect(() => {
    if (!seed) return;
    setRows(entries(seed));
    const range = seed.find((t) => t.kind === "range");
    if (range) {
      setLower(`${range.startFrequencyHz} Hz`);
      setUpper(`${range.endFrequencyHz} Hz`);
    }
  }, [seed]);
  useEffect(() => {
    if (mode !== "frequencies" && mode !== "range") {
      onChange({});
      return;
    }
    try {
      const targets =
        mode === "range"
          ? [
              {
                id: "custom-range",
                kind: "range" as const,
                label: "Custom range",
                startFrequencyHz: parseMonitorFrequency(lower),
                endFrequencyHz: parseMonitorFrequency(upper),
              },
            ]
          : rows.map((r) => ({
              ...frequencyTarget(
                parseMonitorFrequency(r.frequency),
                parseMonitorFrequency(r.width),
                r.label,
              ),
              id: r.id,
            }));
      onChange({ targets: validateMonitorTargets(targets) });
    } catch (e) {
      onChange({
        error: e instanceof Error ? e.message : "Invalid monitor targets.",
      });
    }
  }, [mode, rows, lower, upper, onChange]);
  const attempt = (action: () => void) => {
    try {
      action();
      setNotice("");
    } catch (e) {
      setNotice(e instanceof Error ? e.message : "Could not update targets.");
    }
  };
  const add = (hz?: number, name = label) =>
    attempt(() => {
      const next = {
        ...frequencyTarget(
          hz ?? parseMonitorFrequency(frequency),
          parseMonitorFrequency(width),
          name,
        ),
      };
      const row = entries([next])[0]!;
      const nextRows = [...rows, row];
      validateMonitorTargets(
        nextRows.map((r) => ({
          ...frequencyTarget(
            parseMonitorFrequency(r.frequency),
            parseMonitorFrequency(r.width),
            r.label,
          ),
          id: r.id,
        })),
      );
      setRows(nextRows);
    });
  const getTargets = () =>
    validateMonitorTargets(
      rows.map((r) => ({
        ...frequencyTarget(
          parseMonitorFrequency(r.frequency),
          parseMonitorFrequency(r.width),
          r.label,
        ),
        id: r.id,
      })),
    );
  if (mode !== "frequencies" && mode !== "range") return null;
  return (
    <section
      className="custom-monitor-editor"
      aria-label="Custom monitor targets"
    >
      <h4>Custom monitor</h4>
      <p>
        Watch a frequency, a list of frequencies, or a frequency range you
        choose. Track activity and changes without selecting a band plan.
      </p>
      <fieldset disabled={disabled}>
        <legend>
          {mode === "range" ? "Custom range" : "Custom frequencies"}
        </legend>
        {mode === "range" ? (
          <div className="custom-monitor-fields">
            <label
              data-changed={changedFrequency(
                lower,
                activeTargets?.find((t) => t.kind === "range")
                  ?.startFrequencyHz,
              )}
            >
              Range start
              <input
                aria-label="Range start"
                aria-invalid={!!fieldError(lower)}
                aria-describedby={`${fieldId}-start-error`}
                value={lower}
                onChange={(e) => setLower(e.target.value)}
                placeholder="99.2 MHz"
              />
              {fieldError(lower) && (
                <small id={`${fieldId}-start-error`} role="alert">
                  {fieldError(lower)}
                </small>
              )}
            </label>
            <label
              data-changed={changedFrequency(
                upper,
                activeTargets?.find((t) => t.kind === "range")?.endFrequencyHz,
              )}
            >
              Range end
              <input
                aria-label="Range end"
                aria-invalid={!!fieldError(upper) || !!rangeError}
                aria-describedby={`${fieldId}-end-error`}
                value={upper}
                onChange={(e) => setUpper(e.target.value)}
                placeholder="100.6 MHz"
              />
              {(fieldError(upper) || rangeError) && (
                <small id={`${fieldId}-end-error`} role="alert">
                  {fieldError(upper) || rangeError}
                </small>
              )}
            </label>
          </div>
        ) : (
          <>
            <div className="custom-monitor-fields">
              <label>
                Frequency
                <input
                  aria-label="Frequency"
                  aria-invalid={!!fieldError(frequency)}
                  aria-describedby={`${fieldId}-frequency-error`}
                  value={frequency}
                  onChange={(e) => setFrequency(e.target.value)}
                />
                {fieldError(frequency) && (
                  <small id={`${fieldId}-frequency-error`} role="alert">
                    {fieldError(frequency)}
                  </small>
                )}
              </label>
              <label>
                Watch width
                <input
                  aria-label="Watch width"
                  aria-invalid={!!fieldError(width)}
                  aria-describedby={`${fieldId}-width-error`}
                  value={width}
                  onChange={(e) => setWidth(e.target.value)}
                  list="monitor-widths"
                />
                {fieldError(width) && (
                  <small id={`${fieldId}-width-error`} role="alert">
                    {fieldError(width)}
                  </small>
                )}
              </label>
              <datalist id="monitor-widths">
                <option value="12.5 kHz" />
                <option value="25 kHz" />
                <option value="200 kHz" />
              </datalist>
              <label>
                Label (optional)
                <input
                  maxLength={100}
                  value={label}
                  onChange={(e) => setLabel(e.target.value)}
                />
              </label>
            </div>
            <div className="monitor-actions">
              <button type="button" className="secondary" onClick={() => add()}>
                Add frequency
              </button>
              <button
                type="button"
                className="secondary"
                disabled={!currentFrequencyHz}
                onClick={() => add(currentFrequencyHz, "Receiver frequency")}
              >
                Add current frequency
              </button>
            </div>
            <div className="custom-monitor-entries">
              {rows.map((r, i) => (
                <div className="custom-monitor-entry" key={r.id}>
                  <label
                    data-changed={changedFrequency(
                      r.frequency,
                      (() => {
                        const target = activeTargets?.find(
                          (t) => t.id === r.id,
                        );
                        return target
                          ? (target.startFrequencyHz + target.endFrequencyHz) /
                              2
                          : undefined;
                      })(),
                    )}
                  >
                    Frequency {i + 1}
                    <input
                      aria-label={`Frequency ${i + 1}`}
                      aria-invalid={!!fieldError(r.frequency)}
                      aria-describedby={`${fieldId}-${r.id}-frequency-error`}
                      value={r.frequency}
                      onChange={(e) =>
                        setRows(
                          rows.map((x) =>
                            x.id === r.id
                              ? { ...x, frequency: e.target.value }
                              : x,
                          ),
                        )
                      }
                    />
                    {fieldError(r.frequency) && (
                      <small
                        id={`${fieldId}-${r.id}-frequency-error`}
                        role="alert"
                      >
                        {fieldError(r.frequency)}
                      </small>
                    )}
                  </label>
                  <label
                    data-changed={changedFrequency(
                      r.width,
                      (() => {
                        const target = activeTargets?.find(
                          (t) => t.id === r.id,
                        );
                        return target
                          ? target.endFrequencyHz - target.startFrequencyHz
                          : undefined;
                      })(),
                    )}
                  >
                    Watch width {i + 1}
                    <input
                      aria-label={`Watch width ${i + 1}`}
                      aria-invalid={!!fieldError(r.width)}
                      aria-describedby={`${fieldId}-${r.id}-width-error`}
                      value={r.width}
                      onChange={(e) =>
                        setRows(
                          rows.map((x) =>
                            x.id === r.id ? { ...x, width: e.target.value } : x,
                          ),
                        )
                      }
                    />
                    {fieldError(r.width) && (
                      <small id={`${fieldId}-${r.id}-width-error`} role="alert">
                        {fieldError(r.width)}
                      </small>
                    )}
                  </label>
                  <label>
                    Label {i + 1}
                    <input
                      value={r.label}
                      maxLength={100}
                      onChange={(e) =>
                        setRows(
                          rows.map((x) =>
                            x.id === r.id ? { ...x, label: e.target.value } : x,
                          ),
                        )
                      }
                    />
                  </label>
                  <button
                    type="button"
                    className="secondary"
                    aria-label={`Remove frequency ${i + 1}`}
                    onClick={() => setRows(rows.filter((x) => x.id !== r.id))}
                  >
                    Remove
                  </button>
                </div>
              ))}
            </div>
            <small>
              1–64 targets. Use Hz, kHz, MHz or GHz. Watch width is the searched
              region, separate from a detected signal’s bandwidth and your
              listening filter.
            </small>
            <details>
              <summary>Paste frequencies or add favorites</summary>
              <label>
                Frequencies, one per line
                <textarea
                  value={paste}
                  onChange={(e) => setPaste(e.target.value)}
                  maxLength={10000}
                  placeholder={"99.77 MHz\n100.125 MHz"}
                />
              </label>
              <button
                type="button"
                className="secondary"
                onClick={() =>
                  attempt(() => {
                    const added = paste
                      .split(/\r?\n/)
                      .filter((v) => v.trim())
                      .map((v) =>
                        frequencyTarget(
                          parseMonitorFrequency(v),
                          parseMonitorFrequency(width),
                        ),
                      );
                    const targets = validateMonitorTargets([
                      ...getTargetsAllowEmpty(),
                      ...added,
                    ]);
                    setRows(entries(targets));
                    setPaste("");
                  })
                }
              >
                Add pasted frequencies
              </button>
              <button
                type="button"
                className="secondary"
                onClick={() =>
                  attempt(() => {
                    const json = localStorage.getItem(BOOKMARK_KEY);
                    setFavorites(json ? importBookmarks(json) : []);
                    setChosen(new Set());
                  })
                }
              >
                Choose favorites
              </button>
              {favorites.map((f) => (
                <label className="custom-monitor-favorite" key={f.id}>
                  <input
                    type="checkbox"
                    checked={chosen.has(f.id)}
                    onChange={(e) => {
                      const next = new Set(chosen);
                      if (e.target.checked) next.add(f.id);
                      else next.delete(f.id);
                      setChosen(next);
                    }}
                  />
                  {f.name} · {f.frequencyHz / 1e6} MHz
                </label>
              ))}
              {!!favorites.length && (
                <button
                  type="button"
                  className="secondary"
                  disabled={!chosen.size}
                  onClick={() =>
                    attempt(() => {
                      const added = favorites
                        .filter((f) => chosen.has(f.id))
                        .map((f) =>
                          frequencyTarget(
                            f.frequencyHz,
                            parseMonitorFrequency(width),
                            f.name,
                          ),
                        );
                      setRows(
                        entries(
                          validateMonitorTargets([
                            ...getTargetsAllowEmpty(),
                            ...added,
                          ]),
                        ),
                      );
                      setFavorites([]);
                    })
                  }
                >
                  Add selected favorites
                </button>
              )}
            </details>
            <details className="monitor-watchlists">
              <summary>Watchlists</summary>
              <label>
                Watchlist name
                <input
                  value={listName}
                  maxLength={100}
                  onChange={(e) => setListName(e.target.value)}
                />
              </label>
              <button
                type="button"
                className="secondary"
                disabled={!!lists.error}
                onClick={() =>
                  attempt(() => {
                    const item = {
                      version: 1 as const,
                      id: crypto.randomUUID(),
                      name: listName,
                      targets: getTargets(),
                    };
                    const saved = saveWatchlists([...lists.items, item]);
                    setLists({ items: saved, error: "" });
                    setListId(item.id);
                  })
                }
              >
                Save new watchlist
              </button>
              <label>
                Saved watchlist
                <select
                  aria-label="Saved watchlist"
                  value={listId}
                  onChange={(e) => setListId(e.target.value)}
                >
                  <option value="">Choose a watchlist</option>
                  {lists.items.map((w) => (
                    <option key={w.id} value={w.id}>
                      {w.name}
                    </option>
                  ))}
                </select>
              </label>
              <div className="monitor-actions">
                <button
                  type="button"
                  className="secondary"
                  disabled={!listId}
                  onClick={() =>
                    attempt(() => {
                      const item = lists.items.find((w) => w.id === listId)!;
                      setRows(entries(item.targets));
                      setListName(item.name);
                    })
                  }
                >
                  Load watchlist
                </button>
                <button
                  type="button"
                  className="secondary"
                  disabled={!listId}
                  onClick={() =>
                    attempt(() => {
                      const saved = saveWatchlists(
                        lists.items.filter((w) => w.id !== listId),
                      );
                      setLists({ items: saved, error: "" });
                      setListId("");
                    })
                  }
                >
                  Delete watchlist
                </button>
              </div>
              <small>
                Loading replaces this draft. Lists stay on this browser; target
                edits take effect in a new monitoring session.
              </small>
              {lists.error && <p role="alert">{lists.error}</p>}
            </details>
          </>
        )}
      </fieldset>
      {notice && <p role="alert">{notice}</p>}
    </section>
  );
  function getTargetsAllowEmpty() {
    return rows.length ? getTargets() : [];
  }
}

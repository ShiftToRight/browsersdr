import { useEffect, useState } from "react";
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
  onChange,
}: {
  mode: MonitorTargetMode;
  disabled: boolean;
  currentFrequencyHz?: number;
  seed?: MonitorTarget[];
  onChange: (draft: CustomTargetDraft) => void;
}) {
  const [rows, setRows] = useState<Entry[]>([]);
  const [frequency, setFrequency] = useState("99.77 MHz"),
    [width, setWidth] = useState("25 kHz"),
    [label, setLabel] = useState("");
  const [lower, setLower] = useState("99.2 MHz"),
    [upper, setUpper] = useState("100.6 MHz");
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
            <label>
              Range start
              <input
                value={lower}
                onChange={(e) => setLower(e.target.value)}
                placeholder="99.2 MHz"
              />
            </label>
            <label>
              Range end
              <input
                value={upper}
                onChange={(e) => setUpper(e.target.value)}
                placeholder="100.6 MHz"
              />
            </label>
          </div>
        ) : (
          <>
            <div className="custom-monitor-fields">
              <label>
                Frequency
                <input
                  value={frequency}
                  onChange={(e) => setFrequency(e.target.value)}
                />
              </label>
              <label>
                Watch width
                <input
                  value={width}
                  onChange={(e) => setWidth(e.target.value)}
                  list="monitor-widths"
                />
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
                  <label>
                    Frequency {i + 1}
                    <input
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
                  </label>
                  <label>
                    Watch width {i + 1}
                    <input
                      value={r.width}
                      onChange={(e) =>
                        setRows(
                          rows.map((x) =>
                            x.id === r.id ? { ...x, width: e.target.value } : x,
                          ),
                        )
                      }
                    />
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

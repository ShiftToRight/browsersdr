import {
  parseMonitorFrequency,
  frequencyTarget,
  validateMonitorTargets,
} from "../radio/customMonitor";
import { useState } from "react";
import type { SurveyProfile } from "../radio/fieldSurvey";
import { validateSurveyProfile } from "../radio/fieldSurvey";
import {
  loadExplorerPreferences,
  readPreference,
  storePreference,
  type ExplorerPreferences,
} from "./explorerPreferences";
import { RememberedDetails } from "./ExplorerPreferencesUI";

export interface ExplorerSetup {
  settings: ExplorerPreferences;
  profile: SurveyProfile;
  enabledBandIds: string[];
  custom: Record<string, unknown>;
  analyze: boolean;
  budget: number;
}
interface NamedSetup {
  name: string;
  value: ExplorerSetup;
}
const KEY = "browsersdr.explorerSetups.v1";
/** Bounded preferences, never receiver commands or measurement history. */
export function validateExplorerSetup(raw: unknown): ExplorerSetup {
  if (!raw || typeof raw !== "object" || JSON.stringify(raw).length > 40000)
    throw new Error("Invalid scan setup.");
  const v = raw as ExplorerSetup;
  const profile = validateSurveyProfile(v.profile);
  const settings = loadExplorerPreferences(
    v.settings as Record<string, unknown>,
  );
  if (
    !settings.monitorTargetMode ||
    !settings.monitorPreset ||
    settings.dwellMs === undefined ||
    settings.thresholdDb === undefined ||
    !settings.detector
  )
    throw new Error("Incomplete scan setup.");
  if (
    !Array.isArray(v.enabledBandIds) ||
    v.enabledBandIds.length > 128 ||
    !v.enabledBandIds.every(
      (id) => typeof id === "string" && profile.bands.some((b) => b.id === id),
    )
  )
    throw new Error("Invalid setup bands.");
  if (!v.custom || typeof v.custom !== "object" || Array.isArray(v.custom))
    throw new Error("Invalid setup targets.");
  if (settings.monitorTargetMode === "range") {
    validateMonitorTargets([
      {
        id: "custom-range",
        kind: "range",
        label: "Custom range",
        startFrequencyHz: parseMonitorFrequency(String(v.custom.lower ?? "")),
        endFrequencyHz: parseMonitorFrequency(String(v.custom.upper ?? "")),
      },
    ]);
  }
  if (settings.monitorTargetMode === "frequencies") {
    if (!Array.isArray(v.custom.rows) || v.custom.rows.length > 64)
      throw new Error("Invalid setup frequencies.");
    validateMonitorTargets(
      v.custom.rows.map((row) =>
        frequencyTarget(
          parseMonitorFrequency(row.frequency),
          parseMonitorFrequency(row.width),
          String(row.label ?? ""),
        ),
      ),
    );
  }
  if (typeof v.analyze !== "boolean" || ![6, 12, 20, 30].includes(v.budget))
    throw new Error("Invalid analysis settings.");
  return {
    settings,
    profile,
    enabledBandIds: v.enabledBandIds,
    custom: v.custom,
    analyze: v.analyze,
    budget: v.budget,
  };
}
function load(): NamedSetup[] {
  const raw = readPreference(KEY).setups;
  if (!Array.isArray(raw)) return [];
  return raw.slice(0, 12).flatMap((v) => {
    try {
      return typeof v.name === "string" && v.name.trim() && v.name.length <= 80
        ? [{ name: v.name, value: validateExplorerSetup(v.value) }]
        : [];
    } catch {
      return [];
    }
  });
}
export function ExplorerSavedSetups({
  snapshot,
  onLoad,
  disabled,
}: {
  snapshot: () => ExplorerSetup;
  onLoad: (value: ExplorerSetup) => void;
  disabled: boolean;
}) {
  const [setups, setSetups] = useState(load);
  const [name, setName] = useState("");
  const [chosen, setChosen] = useState("");
  const [message, setMessage] = useState("");
  const persist = (next: NamedSetup[]) => {
    setSetups(next);
    return storePreference(KEY, { version: 1, setups: next });
  };
  return (
    <RememberedDetails
      preference="savedSetups"
      className="explorer-saved-setups"
    >
      <summary>
        Saved scan setups {setups.length ? `(${setups.length})` : ""}
      </summary>
      <label>
        Setup name
        <input
          value={name}
          maxLength={80}
          onChange={(e) => setName(e.target.value)}
          placeholder="e.g. Local FM survey"
        />
      </label>
      <button
        type="button"
        className="secondary"
        disabled={disabled || !name.trim()}
        onClick={() => {
          try {
            const clean = name.trim();
            if (setups.length >= 12 && !setups.some((s) => s.name === clean))
              throw new Error(
                "12 setups saved. Remove one before adding another.",
              );
            const value = validateExplorerSetup(snapshot());
            const saved = persist([
              ...setups.filter((s) => s.name !== clean),
              { name: clean, value },
            ]);
            setChosen(clean);
            setMessage(
              saved
                ? `Saved “${clean}”.`
                : "Setup is in memory. Retry saving below.",
            );
          } catch (error) {
            setMessage(
              error instanceof Error ? error.message : "Could not save setup.",
            );
          }
        }}
      >
        {setups.some((s) => s.name === name.trim())
          ? "Replace named setup"
          : "Save complete setup"}
      </button>
      {!!setups.length && (
        <>
          <label>
            Saved setup
            <select
              aria-label="Saved setup"
              value={chosen}
              onChange={(e) => setChosen(e.target.value)}
            >
              <option value="">Choose a setup</option>
              {setups.map((s) => (
                <option key={s.name}>{s.name}</option>
              ))}
            </select>
          </label>
          <div className="monitor-actions">
            <button
              type="button"
              className="secondary"
              disabled={disabled || !chosen}
              onClick={() => {
                const setup = setups.find((s) => s.name === chosen);
                if (!setup) return;
                onLoad(structuredClone(setup.value));
                setMessage(
                  `Loaded “${chosen}” as a draft. Acquisition stays stopped.`,
                );
              }}
            >
              Load setup
            </button>
            <button
              type="button"
              className="secondary"
              disabled={!chosen}
              onClick={() => {
                persist(setups.filter((s) => s.name !== chosen));
                setChosen("");
                setMessage("Saved setup removed.");
              }}
            >
              Remove setup
            </button>
          </div>
        </>
      )}
      <small>
        Targets, band plan, detection and analysis choices. Loading changes the
        draft; Apply starts a new history.
      </small>
      {message && <p role="status">{message}</p>}
    </RememberedDetails>
  );
}

import { useId, useState } from "react";
import { parseDiscoveryFrequency } from "../radio/discoveryGuides";
import {
  ANTENNA_GUIDES,
  antennaGuideFor,
  antennaLengths,
  antennaLengthLabel,
  type AntennaContext,
  type AntennaGuideId,
  type AntennaGuideRecord,
  type AntennaUnits,
} from "../radio/antennaGuide";
import { AppIcon } from "./AppIcon";
import {
  ANTENNA_TYPES,
  DESIGN_ADVICE,
  DEFAULT_WHIP,
  isAntennaChoice,
  isWhip,
  type AntennaChoice,
  type WhipPreferences,
} from "../radio/antennaDesigns";
import {
  AntennaPresetControls,
  DipoleLengths,
  PresetBandNote,
  WhipFit,
  DesignConcept,
  DesignSources,
} from "./AntennaDesignControls";
import {
  builtinPreset,
  compatiblePreset,
  convertPresetDimensions,
  customPresetFromSettings,
  customPresetKey,
  MAX_CUSTOM_PRESETS,
  presetSettings,
  readCustomPresets,
  type CustomAntennaPreset,
} from "../radio/antennaPresets";
import "./AntennaGuide.css";

export interface AntennaGuideProps {
  context: AntennaContext;
  initialGuideId?: AntennaGuideId;
}
const preferenceKey = "browsersdr.antenna-guide.v1";
function readGuidePreferences(): {
  units: AntennaUnits;
  antenna: AntennaChoice;
} & WhipPreferences {
  try {
    const saved = JSON.parse(localStorage.getItem(preferenceKey) ?? "null");
    if (saved?.version !== 1)
      return { units: "metric", antenna: "recommended", ...DEFAULT_WHIP };
    const antenna = isAntennaChoice(saved.antenna)
      ? saved.antenna
      : "recommended";
    const profiles = readCustomPresets();
    const preset =
      typeof saved.preset === "string" &&
      compatiblePreset(saved.preset, antenna, profiles)
        ? saved.preset
        : "custom";
    const origin =
      typeof saved.originPreset === "string"
        ? saved.originPreset
        : (builtinPreset(preset)?.id ?? "");
    const draft = (value: unknown, fallback = "") =>
      typeof value === "string" && value.length <= 16 ? value : fallback;
    return {
      units: saved.units === "imperial" ? "imperial" : "metric",
      antenna,
      preset,
      minimum: draft(saved.minimum),
      maximum: draft(saved.maximum),
      fixedSection: draft(saved.fixedSection, "0"),
      originPreset: builtinPreset(origin)?.antenna === antenna ? origin : "",
      showEighth: saved.showEighth === true,
    };
  } catch {
    return { units: "metric", antenna: "recommended", ...DEFAULT_WHIP };
  }
}
const tabs = ["For this signal", "Length calculator", "Browse guides"] as const;
function MonopoleDiagram({
  frequencyHz,
  units,
  direct = false,
}: {
  frequencyHz: number;
  units: AntennaUnits;
  direct?: boolean;
}) {
  const length = antennaLengthLabel(
    antennaLengths(frequencyHz).quarterWaveM,
    units,
  );
  return (
    <figure className="antenna-drawing antenna-monopole-drawing">
      <svg
        viewBox="0 0 500 270"
        role="img"
        aria-label={
          direct
            ? `Direct-attached telescopic whip: quarter-wave target ${length}, exposed metal mast only. Connector and receiver excluded; receiver and cable affect the return path. Schematic not to scale.`
            : `Telescopic monopole on a magnetic base: quarter-wave target ${length}, measured from its mounting end to the tip. Do not include the base or coax. Base sits on a broad metal ground plane; schematic not to scale.`
        }
      >
        <text x="250" y="25" textAnchor="middle" className="antenna-svg-muted">
          TELESCOPIC MONOPOLE · QUARTER WAVE
        </text>
        {!direct && (
          <path
            d="M66 214L335 214L398 235H102Z"
            className="antenna-metal-plane"
          />
        )}
        <path d="M206 51V92" className="antenna-mast-tip" />
        <path d="M206 92V137" className="antenna-mast-middle" />
        <path d="M206 137V181" className="antenna-element" />
        <path d="M198 92H214 M197 137H215" className="antenna-radials" />
        <path
          d="M248 51V181 M241 51H255 M241 181H255"
          className="antenna-measure"
        />
        <text x="267" y="106">
          {length}
        </text>
        <text x="267" y="130" className="antenna-svg-muted">
          metal mast only
        </text>
        {direct ? (
          <path
            d="M196 181H216V197H196Z M158 197H254V238H158Z"
            className="antenna-magnetic-base"
          />
        ) : (
          <path
            d="M191 181H221V198H191Z M176 198H236L244 214H168Z"
            className="antenna-magnetic-base"
          />
        )}
        <path
          d={
            direct
              ? "M254 218H334Q351 218 351 190H393"
              : "M243 206H334Q351 206 351 190H393"
          }
          className="antenna-feed"
        />
        <text x="393" y="177" textAnchor="end" className="antenna-svg-muted">
          {direct ? "Cable / return path" : "Coax to receiver"}
        </text>
        <text x="83" y="180" className="antenna-svg-muted">
          {direct ? "Connector" : "Magnetic base"}
        </text>
        <path d="M151 184L176 200" className="antenna-measure" />
        <text x="250" y="260" textAnchor="middle" className="antenna-svg-muted">
          {direct
            ? "Receiver chassis · schematic"
            : "Broad metal surface / ground plane"}
        </text>
      </svg>
      <figcaption>
        Quarter-wave target, not a forced extension setting. Measure from the
        metal mast's mounting end to its tip, including fixed exposed metal
        sections.{" "}
        {direct
          ? "Exclude the connector, receiver and cable."
          : "Exclude the magnetic base and cable."}{" "}
        Illustration is schematic; the feed and surroundings affect the final
        optimum.
      </figcaption>
    </figure>
  );
}
function MonopoleLength({
  frequencyHz,
  units,
  preferences,
}: {
  frequencyHz: number;
  units: AntennaUnits;
  preferences: WhipPreferences;
}) {
  const lengthM = antennaLengths(frequencyHz).quarterWaveM;
  return (
    <>
      <div className="antenna-whip-length" aria-live="polite">
        <span>Quarter-wave target · metal mast only</span>
        <strong>
          {antennaLengthLabel(antennaLengths(frequencyHz).quarterWaveM, units)}
        </strong>
        <span>One quarter-wave radiator · starting estimate</span>
      </div>
      <WhipFit lengthM={lengthM} preferences={preferences} units={units} />
      <PresetBandNote frequencyHz={frequencyHz} preferences={preferences} />
      {preferences.showEighth && (
        <div className="antenna-eighth-result">
          <span>Compact experiment · eighth wave</span>
          <strong>{antennaLengthLabel(lengthM / 2, units)}</strong>
          <p>
            A bare eighth-wave whip is not automatically resonant or matched. It
            may receive signals, but shortening can worsen reception. Compare it
            with the longest practical setting; loading and matching require a
            complete design.
          </p>
          <WhipFit
            lengthM={lengthM / 2}
            preferences={preferences}
            units={units}
          />
        </div>
      )}
    </>
  );
}
function MonopoleDetails() {
  return (
    <div className="antenna-monopole-details">
      <p>
        Start upright, with the magnetic base on a broad steel surface such as a
        baking tray. Compare placement and orientation for your signal. Check
        the mast's minimum and maximum extension; do not force it to reach a
        calculated length.
      </p>
      <p>
        For the Nooelec RaTLSnake telescopic mast, the manufacturer lists
        approximately 100–800 MHz depending on extension. This is an advertised
        range, not a measured limit or a guarantee that every calculated length
        fits the mast.
      </p>
      <p className="antenna-small">
        <a
          href="https://support.nooelec.com/hc/en-us/articles/360005814794-RF-Accessories-Balun-Antennas"
          target="_blank"
          rel="noopener noreferrer"
        >
          Nooelec antenna FAQ
        </a>{" "}
        · updated 24 September 2019 · reviewed 19 October 2026.{" "}
        <a
          href="https://www.nooelec.com/store/ratlsnake-m6.html"
          target="_blank"
          rel="noopener noreferrer"
        >
          Magnetic-base description
        </a>{" "}
        · publication date unknown · reviewed 19 October 2026.
      </p>
    </div>
  );
}
function Diagram({
  guide,
  frequencyHz,
  units,
}: {
  guide: Pick<AntennaGuideRecord, "shape">;
  frequencyHz: number;
  units: AntennaUnits;
}) {
  const lengths = antennaLengths(frequencyHz);
  const label = (m: number) => antennaLengthLabel(m, units);
  return (
    <figure className="antenna-drawing">
      <svg
        viewBox="0 0 500 238"
        role="img"
        aria-label={
          guide.shape === "v-dipole"
            ? "137 MHz V-dipole, viewed from above: two 53.4 cm arms at 120 degrees, lying horizontally, joined at the feed point."
            : guide.shape === "dipole"
              ? `Center-fed half-wave dipole: two ideal ${label(lengths.quarterWaveM)} arms, total ${label(lengths.halfWaveM)}. Rotate to match the broadcast polarization.`
              : `Vertical quarter-wave radiator, ideal length ${label(lengths.quarterWaveM)}, with four illustrative ground-plane radials and coax below the feed point.`
        }
      >
        {guide.shape === "dipole" ? (
          <>
            <text
              x="250"
              y="27"
              textAnchor="middle"
              className="antenna-svg-muted"
            >
              HALF-WAVE DIPOLE · IDEAL DIMENSIONS
            </text>
            <path d="M50 110H237 M263 110H450" className="antenna-element" />
            <path
              d="M244 119V158H250V201 M256 119V158"
              className="antenna-feed"
            />
            <path
              d="M50 66H237 M263 66H450 M50 60V72 M237 60V72 M263 60V72 M450 60V72"
              className="antenna-measure"
            />
            <text x="145" y="55" textAnchor="middle">
              {label(lengths.quarterWaveM)} per arm
            </text>
            <text x="355" y="55" textAnchor="middle">
              {label(lengths.quarterWaveM)} per arm
            </text>
            <circle cx="244" cy="110" r="6" />
            <circle cx="256" cy="110" r="6" />
            <text x="280" y="146" textAnchor="start">
              Feed point
            </text>
            <text
              x="250"
              y="226"
              textAnchor="middle"
              className="antenna-svg-muted"
            >
              {label(lengths.halfWaveM)} tip to tip · coax below
            </text>
          </>
        ) : guide.shape === "ground-plane" ? (
          <>
            <text
              x="250"
              y="27"
              textAnchor="middle"
              className="antenna-svg-muted"
            >
              QUARTER-WAVE GROUND PLANE
            </text>
            <path d="M250 55V149" className="antenna-element" />
            <path
              d="M250 149L120 178 M250 149L380 178 M250 149L166 128 M250 149L334 128"
              className="antenna-radials"
            />
            <path d="M250 158V204" className="antenna-feed" />
            <circle cx="250" cy="149" r="6" />
            <path
              d="M298 55V149 M292 55H304 M292 149H304"
              className="antenna-measure"
            />
            <text x="315" y="98">
              {label(lengths.quarterWaveM)}
            </text>
            <text x="315" y="119" className="antenna-svg-muted">
              radiator
            </text>
            <text x="110" y="200" className="antenna-svg-muted">
              Radials ≈ {label(lengths.quarterWaveM)} each
            </text>
            <text
              x="250"
              y="228"
              textAnchor="middle"
              className="antenna-svg-muted"
            >
              Coax at feed point · radials shown schematically
            </text>
          </>
        ) : (
          <>
            <text
              x="250"
              y="27"
              textAnchor="middle"
              className="antenna-svg-muted"
            >
              HORIZONTAL V-DIPOLE · VIEW FROM ABOVE
            </text>
            <path
              d="M250 164L86 70 M250 164L414 70"
              className="antenna-element"
            />
            <path d="M211 142Q250 110 289 142" className="antenna-measure" />
            <text x="250" y="112" textAnchor="middle">
              120°
            </text>
            <text x="130" y="110" textAnchor="middle">
              {label(0.534)}
            </text>
            <text x="370" y="110" textAnchor="middle">
              {label(0.534)}
            </text>
            <circle cx="250" cy="164" r="6" />
            <text x="250" y="191" textAnchor="middle">
              Feed point · coax underneath
            </text>
            <text
              x="250"
              y="226"
              textAnchor="middle"
              className="antenna-svg-muted"
            >
              137 MHz kit design · both arms lie flat
            </text>
          </>
        )}
      </svg>
      <figcaption>
        {guide.shape === "v-dipole"
          ? "Named 137 MHz design from the kit instructions; not a scaled QFH or a general length formula."
          : "Starting dimensions, not a tuned construction drawing. Thickness, insulation, feed and surroundings affect the final antenna."}
      </figcaption>
    </figure>
  );
}
function QfhDiagram() {
  return (
    <figure className="antenna-qfh">
      <svg
        viewBox="0 0 200 215"
        role="img"
        aria-label="QFH concept: two crossed twisted loops around an upright mast. Loop geometry and feed phasing determine polarization and coverage; schematic only, with no build dimensions."
      >
        <path d="M100 24V190" className="antenna-measure" />
        <path
          d="M100 35C165 37 168 78 100 103S33 170 100 174C165 172 168 129 100 103S33 37 100 35Z"
          className="antenna-element"
        />
        <path
          d="M100 35C42 58 151 151 100 174C49 151 158 58 100 35Z"
          className="antenna-radials"
        />
        <text x="100" y="210" textAnchor="middle">
          QFH · schematic only
        </text>
      </svg>
      <figcaption>
        Twisted, phased elements receive circular polarization. Follow a
        complete design with the correct handedness.
      </figcaption>
    </figure>
  );
}

export function AntennaGuide({ context, initialGuideId }: AntennaGuideProps) {
  const id = useId();
  const [snapshot, setSnapshot] = useState(context);
  const [selection, setSelection] = useState(() => {
    const guide = initialGuideId
      ? ANTENNA_GUIDES.find((item) => item.id === initialGuideId)
      : antennaGuideFor(context.mode, context.frequencyHz);
    const inRange =
      guide &&
      context.frequencyHz !== undefined &&
      context.frequencyHz >= guide.range[0] &&
      context.frequencyHz <= guide.range[1];
    return {
      id: guide?.id,
      frequencyHz: inRange
        ? context.frequencyHz!
        : (guide?.frequencyHz ?? context.frequencyHz ?? 100e6),
      example: !inRange,
    };
  });
  const [tab, setTab] = useState<(typeof tabs)[number]>("For this signal");
  const [preferences, setPreferences] = useState(readGuidePreferences);
  const [customPresets, setCustomPresets] = useState(readCustomPresets);
  const [presetName, setPresetName] = useState(
    () =>
      readCustomPresets().find((p) => p.id === preferences.preset)?.name ?? "",
  );
  const [presetStatus, setPresetStatus] = useState("");
  const [deletedPreset, setDeletedPreset] = useState<{
    preset: CustomAntennaPreset;
    index: number;
  }>();
  const { units, antenna } = preferences;
  const telescopic = isWhip(antenna);
  const selectedDesign = antenna === "recommended" ? undefined : antenna;
  const designAdvice = selectedDesign
    ? DESIGN_ADVICE[selectedDesign]
    : undefined;
  function changePreferences(update: Partial<typeof preferences>) {
    const next = { ...preferences, ...update };
    setPreferences(next);
    try {
      localStorage.setItem(
        preferenceKey,
        JSON.stringify({ version: 1, ...next }),
      );
    } catch {
      /* Optional preferences remain available in this tab. */
    }
  }
  function storeCustomPresets(next: CustomAntennaPreset[]) {
    setCustomPresets(next);
    try {
      localStorage.setItem(
        customPresetKey,
        JSON.stringify({ version: 1, presets: next }),
      );
      return true;
    } catch {
      return false;
    }
  }
  function selectPreset(preset: string) {
    if (preset === "custom")
      changePreferences({
        ...DEFAULT_WHIP,
        showEighth: preferences.showEighth,
      });
    else {
      const next = presetSettings(preset, units, customPresets);
      if (!next) return;
      changePreferences({
        ...next,
        showEighth: builtinPreset(preset)
          ? preferences.showEighth
          : next.showEighth,
      });
    }
    setPresetName(customPresets.find((p) => p.id === preset)?.name ?? "");
    setPresetStatus("");
  }
  function saveCustomPreset(update: boolean) {
    const existing = customPresets.find((p) => p.id === preferences.preset);
    if (update && !existing) return;
    const next = customPresetFromSettings(
      update ? existing!.id : `saved-${crypto.randomUUID()}`,
      presetName,
      antenna,
      preferences,
      units,
    );
    if (typeof next === "string") {
      setPresetStatus(next);
      return;
    }
    if (
      customPresets.some(
        (p) =>
          p.id !== (update ? existing!.id : "") &&
          p.name.toLowerCase() === next.name.toLowerCase(),
      )
    ) {
      setPresetStatus(
        "A preset with this name already exists. Choose another name or update the selected preset.",
      );
      return;
    }
    if (!update && customPresets.length >= MAX_CUSTOM_PRESETS) {
      setPresetStatus(
        `Up to ${MAX_CUSTOM_PRESETS} presets can be saved. Delete one before adding another.`,
      );
      return;
    }
    const list = update
      ? customPresets.map((p) => (p.id === next.id ? next : p))
      : [...customPresets, next];
    const persisted = storeCustomPresets(list);
    changePreferences({ preset: next.id });
    setPresetName(next.name);
    setPresetStatus(
      persisted
        ? `${update ? "Updated" : "Saved"} “${next.name}” in this browser.`
        : `“${next.name}” is available in this tab only; browser storage is unavailable.`,
    );
  }
  function deleteCustomPreset() {
    const index = customPresets.findIndex((p) => p.id === preferences.preset);
    if (index < 0) return;
    const preset = customPresets[index]!;
    setDeletedPreset({ preset, index });
    const persisted = storeCustomPresets(
      customPresets.filter((p) => p.id !== preset.id),
    );
    changePreferences({ preset: "custom" });
    setPresetStatus(
      `Deleted “${preset.name}”${persisted ? ". Undo is available." : " in this tab only; browser storage is unavailable."}`,
    );
  }
  function undoDelete() {
    if (!deletedPreset) return;
    const { preset, index } = deletedPreset;
    if (
      customPresets.length >= MAX_CUSTOM_PRESETS ||
      customPresets.some(
        (p) => p.name.toLowerCase() === preset.name.toLowerCase(),
      )
    ) {
      setPresetStatus(
        "Make room or rename the conflicting preset before restoring this one.",
      );
      return;
    }
    const list = [...customPresets];
    list.splice(Math.min(index, list.length), 0, preset);
    const persisted = storeCustomPresets(list);
    changePreferences(presetSettings(preset.id, units, list)!);
    setPresetName(preset.name);
    setDeletedPreset(undefined);
    setPresetStatus(
      persisted
        ? `Restored “${preset.name}”.`
        : `Restored “${preset.name}” in this tab only; browser storage is unavailable.`,
    );
  }
  const [frequency, setFrequency] = useState(
    () => `${selection.frequencyHz / 1e6} MHz`,
  );
  const guide = ANTENNA_GUIDES.find((item) => item.id === selection.id);
  const label = (m: number) => antennaLengthLabel(m, units);
  const parsed = parseDiscoveryFrequency(frequency);
  let lengths: ReturnType<typeof antennaLengths> | undefined;
  let error = parsed.error;
  if (parsed.frequencyHz !== undefined) {
    try {
      lengths = antennaLengths(parsed.frequencyHz);
    } catch (e) {
      error = (e as Error).message;
    }
  } else if (!error)
    error = "Enter a frequency, for example 100 MHz or 1090 MHz.";
  const changed =
    context.frequencyHz !== snapshot.frequencyHz ||
    context.mode !== snapshot.mode ||
    context.kind !== snapshot.kind ||
    context.sourceLabel !== snapshot.sourceLabel;
  const outside =
    parsed.frequencyHz !== undefined &&
    snapshot.range &&
    (parsed.frequencyHz < snapshot.range.minimumHz ||
      parsed.frequencyHz > snapshot.range.maximumHz);
  function useCurrent() {
    setSnapshot(context);
    const current = antennaGuideFor(context.mode, context.frequencyHz);
    setSelection({
      id: current?.id,
      frequencyHz: context.frequencyHz ?? 100e6,
      example: context.frequencyHz === undefined,
    });
    if (context.frequencyHz !== undefined)
      setFrequency(`${context.frequencyHz / 1e6} MHz`);
  }
  function choose(item: AntennaGuideRecord) {
    const matches =
      snapshot.frequencyHz !== undefined &&
      snapshot.mode === item.mode &&
      snapshot.frequencyHz >= item.range[0] &&
      snapshot.frequencyHz <= item.range[1];
    const hz = matches ? snapshot.frequencyHz! : item.frequencyHz;
    setSelection({ id: item.id, frequencyHz: hz, example: !matches });
    setFrequency(`${hz / 1e6} MHz`);
    setTab("For this signal");
  }
  const contextNote =
    snapshot.kind === "remote"
      ? "Remote receiver: this advice concerns the antenna at that site. Enter its frequency manually; changing your local antenna cannot change the remote installation."
      : snapshot.kind === "replay"
        ? "Replay: these are learning suggestions. A recording cannot reveal which antenna was used unless its metadata says so."
        : snapshot.kind === "demo"
          ? "Synthetic demo: explore antenna setups here; no physical antenna is being measured."
          : "Reception advice only. Browsing leaves tuning, gain and recording unchanged.";
  function selectedSetup(hz: number) {
    if (telescopic)
      return (
        <>
          <MonopoleLength
            frequencyHz={hz}
            units={units}
            preferences={preferences}
          />
          <MonopoleDiagram
            frequencyHz={hz}
            units={units}
            direct={antenna === "whip"}
          />
        </>
      );
    if (
      antenna === "dipole" ||
      antenna === "ground-plane" ||
      antenna === "v-dipole"
    )
      return (
        <>
          {antenna === "v-dipole" && hz !== 137e6 && (
            <p className="antenna-advisory">
              137 MHz reference only. The dimensions below do not describe a
              design for {hz / 1e6} MHz.
            </p>
          )}
          {antenna === "dipole" && (
            <DipoleLengths
              frequencyHz={hz}
              preferences={preferences}
              units={units}
              onSelect={selectPreset}
            />
          )}
          <Diagram guide={{ shape: antenna }} frequencyHz={hz} units={units} />
          {antenna === "dipole" && (
            <p className="antenna-dimension-note">
              Practical starting arm:{" "}
              <strong>{label(antennaLengths(hz).practicalArmM)}</strong> · ideal
              arm: <strong>{label(antennaLengths(hz).quarterWaveM)}</strong>.
              Adjust both arms equally.
            </p>
          )}
        </>
      );
    if (antenna === "qfh") return <QfhDiagram />;
    if (selectedDesign) return <DesignConcept design={selectedDesign} />;
    return null;
  }
  return (
    <section className="antenna-guide" aria-label="Antenna guide content">
      <div className="antenna-context">
        <div>
          <p className="eyebrow">YOUR RECEPTION SETUP</p>
          <strong>
            {snapshot.sourceLabel}
            {snapshot.frequencyHz !== undefined
              ? ` · ${snapshot.frequencyHz / 1e6} MHz${snapshot.mode ? ` · ${snapshot.mode}` : ""}`
              : " · choose a frequency"}
          </strong>
          <p>{contextNote}</p>
        </div>
        <button type="button" className="secondary" onClick={useCurrent}>
          <AppIcon name="retry" />
          Use current channel
        </button>
      </div>
      {changed && (
        <p role="status" className="antenna-context-change">
          The receiver context changed. Your guide and calculator draft are
          retained; use “Use current channel” to refresh.
        </p>
      )}
      <div className="antenna-navigation">
        <div
          role="tablist"
          aria-label="Antenna guide views"
          className="antenna-tabs"
          onKeyDown={(event) => {
            const index = tabs.indexOf(tab);
            const next =
              event.key === "ArrowRight"
                ? (index + 1) % tabs.length
                : event.key === "ArrowLeft"
                  ? (index + tabs.length - 1) % tabs.length
                  : event.key === "Home"
                    ? 0
                    : event.key === "End"
                      ? tabs.length - 1
                      : undefined;
            if (next === undefined) return;
            event.preventDefault();
            setTab(tabs[next]!);
            const buttons =
              event.currentTarget.querySelectorAll<HTMLButtonElement>("button");
            buttons[next]?.focus();
          }}
        >
          {tabs.map((name, index) => (
            <button
              key={name}
              type="button"
              role="tab"
              id={`${id}-tab-${index}`}
              aria-selected={tab === name}
              aria-controls={`${id}-panel`}
              tabIndex={tab === name ? 0 : -1}
              className="secondary"
              onClick={() => setTab(name)}
            >
              {name}
            </button>
          ))}
        </div>
        <div className="antenna-options">
          <label className="antenna-choice">
            Antenna type
            <select
              aria-label="Antenna type"
              value={antenna}
              onChange={(event) => {
                const value = event.currentTarget.value as AntennaChoice;
                changePreferences({
                  ...DEFAULT_WHIP,
                  antenna: value,
                  showEighth: preferences.showEighth,
                });
                setPresetName("");
                setPresetStatus("");
              }}
            >
              {ANTENNA_TYPES.map(([value, name]) => (
                <option key={value} value={value}>
                  {name}
                </option>
              ))}
            </select>
          </label>
          <label className="antenna-units">
            Lengths
            <select
              aria-label="Antenna length units"
              value={units}
              onChange={(event) => {
                const value = event.currentTarget.value as AntennaUnits;
                changePreferences({
                  ...convertPresetDimensions(preferences, units, value),
                  units: value,
                });
              }}
            >
              <option value="metric">cm / m</option>
              <option value="imperial">in / ft</option>
            </select>
          </label>
        </div>
      </div>
      {tab !== "Browse guides" && (
        <AntennaPresetControls
          units={units}
          antenna={antenna}
          preferences={preferences}
          presets={customPresets}
          name={presetName}
          status={presetStatus}
          canUndo={!!deletedPreset}
          onName={setPresetName}
          onSelect={selectPreset}
          onChange={changePreferences}
          onSave={saveCustomPreset}
          onDelete={deleteCustomPreset}
          onUndo={undoDelete}
        />
      )}
      <div
        role="tabpanel"
        id={`${id}-panel`}
        aria-labelledby={`${id}-tab-${tabs.indexOf(tab)}`}
      >
        {tab === "Browse guides" ? (
          <>
            <div className="antenna-intro">
              <h3>What would you like to receive?</h3>
              <p>
                Choose a starting setup. Local signals, placement and your
                receiver determine what you can actually receive.
              </p>
            </div>
            <div className="antenna-catalog">
              {ANTENNA_GUIDES.map((item) => (
                <button
                  key={item.id}
                  type="button"
                  className="secondary antenna-catalog-card"
                  onClick={() => choose(item)}
                >
                  <span className="antenna-card-icon">
                    <AppIcon name="radio" />
                  </span>
                  <strong>{item.name}</strong>
                  <span>{item.band}</span>
                  <span>
                    {item.shape === "v-dipole"
                      ? "V-dipole · QFH alternative"
                      : item.shape === "dipole"
                        ? "Two-arm dipole"
                        : "Vertical ground plane"}
                  </span>
                  <span className="antenna-card-action">View setup →</span>
                </button>
              ))}
            </div>
          </>
        ) : tab === "Length calculator" ? (
          <div className="antenna-calculator">
            <div className="antenna-intro">
              <h3>A starting length for any frequency</h3>
              <p>
                Choose the physical antenna type before cutting or extending an
                element.
              </p>
            </div>
            <label className="antenna-frequency">
              Frequency
              <input
                type="text"
                inputMode="decimal"
                maxLength={40}
                value={frequency}
                placeholder="100 MHz"
                onChange={(event) => setFrequency(event.currentTarget.value)}
                aria-invalid={!!error}
                aria-describedby={`${id}-frequency-note`}
              />
            </label>
            <p id={`${id}-frequency-note`} className="antenna-small">
              {error ??
                (parsed.block
                  ? parsed.notice
                  : "Use Hz, kHz, MHz or GHz. A number without a unit is MHz; decimal commas are accepted.")}
            </p>
            {lengths && (
              <>
                {selectedDesign ? (
                  <>
                    <div className="antenna-intro">
                      <h4>
                        {ANTENNA_TYPES.find(([value]) => value === antenna)![1]}
                      </h4>
                      <p>{designAdvice!.intro}</p>
                    </div>
                    {selectedSetup(parsed.frequencyHz!)}
                    <p className="antenna-small">{designAdvice!.measurement}</p>
                    {antenna === "telescopic" && <MonopoleDetails />}
                    <DesignSources />
                  </>
                ) : (
                  <div className="antenna-metrics" aria-live="polite">
                    <article>
                      <span>Quarter-wave whip</span>
                      <strong>{label(lengths.quarterWaveM)}</strong>
                      <p>
                        Radiator only · needs a suitable ground plane or
                        counterpoise
                      </p>
                    </article>
                    <article>
                      <span>Half-wave dipole · each arm</span>
                      <strong>
                        {label(lengths.practicalArmM)}–
                        {label(lengths.quarterWaveM)}
                      </strong>
                      <p>
                        Approximate practical estimate to ideal free-space
                        quarter wave
                      </p>
                    </article>
                    <article>
                      <span>Dipole · total span</span>
                      <strong>
                        {label(lengths.practicalDipoleM)}–
                        {label(lengths.halfWaveM)}
                      </strong>
                      <p>Two arms joined at a center feed point</p>
                    </article>
                  </div>
                )}
                <p className="antenna-small">
                  Free-space wavelength: {label(lengths.wavelengthM)}.
                  Dimensions are starting estimates, not guaranteed resonance or
                  reception.
                </p>
                {outside && (
                  <p className="antenna-advisory">
                    Calculation only: outside the selected source's advertised
                    frequency range.
                  </p>
                )}
                {snapshot.range?.limitsDiscoveredAtTune && (
                  <p className="antenna-small">
                    This source discovers its tuner limits at tune time.
                    Calculating a length does not establish tuning support or
                    enable HF/direct sampling.
                  </p>
                )}
                {!selectedDesign && (
                  <Diagram
                    guide={ANTENNA_GUIDES[0]!}
                    frequencyHz={parsed.frequencyHz!}
                    units={units}
                  />
                )}
              </>
            )}
            <details className="antenna-details">
              <summary>How the calculation works</summary>
              <p>
                Wavelength = 299,792,458 ÷ frequency in Hz. A quarter-wave
                radiator is one quarter of that; a half-wave dipole has two
                quarter-wave arms.
              </p>
              <p>
                The practical wire-dipole starting total uses 468 ÷ frequency in
                MHz, in feet. ARRL describes this for wire dipoles; thickness,
                insulation, feed and nearby objects change the result,
                especially for a specific VHF build. This range is not a tuning
                tolerance.
              </p>
              <p>
                These formulas do not calculate QFH loops, helix pitch, phasing
                networks or Yagi elements. Coax velocity factor is not a
                universal wire-element shortening factor.
              </p>
              <a
                href="https://www.arrl.org/single-band-dipoles"
                target="_blank"
                rel="noopener noreferrer"
              >
                ARRL · Single Band Dipoles
              </a>
            </details>
          </div>
        ) : guide ? (
          <article className="antenna-signal">
            <div className="antenna-signal-heading">
              <div>
                <p className="eyebrow">
                  {selection.example
                    ? "GUIDE EXAMPLE"
                    : "FOR YOUR SELECTED CHANNEL"}{" "}
                  · {selection.frequencyHz / 1e6} MHz
                </p>
                <h3>{guide.name}</h3>
                <p>{guide.result}</p>
              </div>
              <button
                type="button"
                className="secondary"
                onClick={() => setTab("Browse guides")}
              >
                Change guide
              </button>
            </div>
            <div className="antenna-setup-grid">
              <div className="antenna-start">
                <p className="eyebrow">
                  {selectedDesign ? "SELECTED ANTENNA TYPE" : "START WITH THIS"}
                </p>
                <h4>
                  {selectedDesign
                    ? antenna === "telescopic"
                      ? "Telescopic monopole"
                      : ANTENNA_TYPES.find(([value]) => value === antenna)![1]
                    : guide.shape === "v-dipole"
                      ? "Horizontal V-dipole"
                      : guide.shape === "dipole"
                        ? "Adjustable two-arm dipole"
                        : "Vertical ground-plane antenna"}
                </h4>
                <p>{designAdvice ? designAdvice.intro : guide.start}</p>
                {selectedDesign ? (
                  selectedSetup(selection.frequencyHz)
                ) : (
                  <Diagram
                    guide={guide}
                    frequencyHz={selection.frequencyHz}
                    units={units}
                  />
                )}
                {!selectedDesign && guide.shape === "dipole" && (
                  <p className="antenna-dimension-note">
                    Practical starting arm:{" "}
                    <strong>
                      {label(
                        antennaLengths(selection.frequencyHz).practicalArmM,
                      )}
                    </strong>{" "}
                    · ideal arm:{" "}
                    <strong>
                      {label(
                        antennaLengths(selection.frequencyHz).quarterWaveM,
                      )}
                    </strong>
                    . Adjust both arms equally.
                  </p>
                )}
                <button
                  type="button"
                  className="secondary"
                  onClick={() => {
                    setFrequency(`${selection.frequencyHz / 1e6} MHz`);
                    setTab("Length calculator");
                  }}
                >
                  Calculate another frequency
                </button>
              </div>
              <div className="antenna-advice">
                <div>
                  <span className="antenna-step">01</span>
                  <h4>Orientation & polarization</h4>
                  <p>
                    {designAdvice
                      ? designAdvice.orientation
                      : guide.polarization}
                  </p>
                </div>
                <div>
                  <span className="antenna-step">02</span>
                  <h4>Find a better position</h4>
                  <p>
                    {designAdvice ? designAdvice.placement : guide.placement}
                  </p>
                </div>
                <div>
                  <span className="antenna-step">03</span>
                  <h4>
                    {telescopic
                      ? "Measure the mast, not the cable"
                      : selectedDesign
                        ? "Dimensions & feed"
                        : "Check before adding gain"}
                  </h4>
                  <p>
                    {designAdvice
                      ? designAdvice.measurement
                      : guide.tips[guide.tips.length - 1]}
                  </p>
                </div>
              </div>
            </div>
            {telescopic && (
              <>
                {guide.id === "satellite" && (
                  <p className="antenna-advisory">
                    A vertical telescopic monopole is a compromise for satellite
                    reception. Length alone does not provide circular
                    polarization or good sky coverage. Choose “Guide
                    recommendation” to see the horizontal V-dipole and QFH
                    alternatives.
                  </p>
                )}
                {antenna === "telescopic" && (
                  <details className="antenna-details">
                    <summary>Magnetic-base setup & RaTLSnake notes</summary>
                    <MonopoleDetails />
                  </details>
                )}
              </>
            )}
            {selectedDesign && <DesignSources />}
            <div className="antenna-capability">
              <AppIcon name="info" />
              <p>{guide.capability}</p>
            </div>
            <details className="antenna-details">
              <summary>
                {selectedDesign
                  ? "Recommended antenna & alternatives"
                  : "Setup details & an optional upgrade"}
              </summary>
              {selectedDesign && <p>{guide.start}</p>}
              <ul>
                {guide.tips.map((tip) => (
                  <li key={tip}>{tip}</li>
                ))}
              </ul>
              <p>{guide.upgrade}</p>
              {guide.id === "satellite" && <QfhDiagram />}
              <p>
                A filter must pass the signal you want. Enable antenna power
                only with an explicitly compatible powered device and a
                supported power arrangement. Outdoor installations need suitable
                weather protection and safe mounting.
              </p>
            </details>
            <details className="antenna-details">
              <summary>Sources & assumptions</summary>
              <p>
                Editorial guidance reviewed 18 October 2026. Source publication
                dates are separate below. No antenna performance was measured
                for this guide; current satellite operation and local
                availability are not verified.
              </p>
              <ul>
                {guide.sources.map((source) => (
                  <li key={source.url}>
                    <a
                      href={source.url}
                      target="_blank"
                      rel="noopener noreferrer"
                    >
                      {source.label}
                    </a>
                    <span> · {source.date}</span>
                  </li>
                ))}
              </ul>
            </details>
          </article>
        ) : selectedDesign ? (
          <article className="antenna-signal">
            <div className="antenna-intro">
              <p className="eyebrow">
                {selection.example
                  ? "EXAMPLE FREQUENCY"
                  : "FOR YOUR SELECTED CHANNEL"}{" "}
                · {selection.frequencyHz / 1e6} MHz
              </p>
              <h3>
                {antenna === "telescopic"
                  ? "Telescopic monopole"
                  : ANTENNA_TYPES.find(([value]) => value === antenna)![1]}
              </h3>
              <p>
                Starting dimensions for this frequency. Choose a reception guide
                to check signal-specific polarization and placement.
              </p>
            </div>
            <p>{designAdvice!.intro}</p>
            {selectedSetup(selection.frequencyHz)}
            <div className="antenna-advice">
              <div>
                <h4>Orientation & polarization</h4>
                <p>{designAdvice!.orientation}</p>
              </div>
              <div>
                <h4>Placement</h4>
                <p>{designAdvice!.placement}</p>
              </div>
              <div>
                <h4>Dimensions & feed</h4>
                <p>{designAdvice!.measurement}</p>
              </div>
            </div>
            {antenna === "telescopic" && <MonopoleDetails />}
            <DesignSources />
            <button
              type="button"
              className="secondary"
              onClick={() => setTab("Length calculator")}
            >
              Calculate another frequency
            </button>
          </article>
        ) : (
          <div className="antenna-empty">
            <AppIcon name="radio" />
            <h3>Choose what you want to receive</h3>
            <p>
              There is no curated setup for this channel and mode. You can still
              calculate element lengths or explore the six reception guides.
            </p>
            <div>
              <button type="button" onClick={() => setTab("Browse guides")}>
                Browse reception guides
              </button>
              <button
                type="button"
                className="secondary"
                onClick={() => setTab("Length calculator")}
              >
                Open length calculator
              </button>
            </div>
          </div>
        )}
      </div>
    </section>
  );
}

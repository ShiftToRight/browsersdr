import { useId } from "react";
import {
  antennaLengths,
  antennaLengthLabel,
  type AntennaUnits,
} from "../radio/antennaGuide";
import {
  isWhip,
  type AntennaChoice,
  parseWhipLimits,
  whipFit,
  type WhipPreferences,
  type SelectedAntenna,
} from "../radio/antennaDesigns";

import {
  ANTENNA_PRESETS,
  MAX_CUSTOM_PRESETS,
  builtinPreset,
  fixedSectionM,
  type CustomAntennaPreset,
} from "../radio/antennaPresets";

export function AntennaPresetControls({
  preferences,
  antenna,
  units,
  presets,
  name,
  status,
  canUndo,
  onName,
  onSelect,
  onChange,
  onSave,
  onDelete,
  onUndo,
}: {
  preferences: WhipPreferences;
  antenna: AntennaChoice;
  units: AntennaUnits;
  presets: readonly CustomAntennaPreset[];
  name: string;
  status: string;
  canUndo: boolean;
  onName: (name: string) => void;
  onSelect: (id: string) => void;
  onChange: (change: Partial<WhipPreferences>) => void;
  onSave: (update: boolean) => void;
  onDelete: () => void;
  onUndo: () => void;
}) {
  const id = useId();
  const whip = isWhip(antenna),
    dipole = antenna === "dipole";
  const dimensions = whip || dipole;
  const limits = parseWhipLimits(
    preferences.minimum,
    preferences.maximum,
    units,
  );
  const fixed = fixedSectionM(preferences, units);
  const model = builtinPreset(preferences.originPreset);
  const saved = presets.some((p) => p.id === preferences.preset);
  const unit = units === "metric" ? "cm" : "in";
  function edit(change: Partial<WhipPreferences>) {
    onChange({
      ...change,
      preset: saved ? preferences.preset : "custom",
      originPreset: "",
    });
  }
  return (
    <fieldset
      className={`antenna-preset-controls${whip ? " antenna-whip-controls" : ""}${dipole ? " antenna-dipole-controls" : ""}`}
    >
      <legend>
        {whip
          ? "Whip length limits"
          : dipole
            ? "Dipole element set & limits"
            : "Antenna presets"}
      </legend>
      <div
        className={`antenna-limit-fields${dimensions ? "" : " antenna-preset-only"}`}
      >
        <label>
          Antenna preset
          <select
            aria-label="Antenna preset"
            value={preferences.preset}
            onChange={(e) => onSelect(e.currentTarget.value)}
          >
            <option value="custom">Custom / no preset</option>
            <optgroup label="Built-in profiles">
              {ANTENNA_PRESETS.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </optgroup>
            {presets.length > 0 && (
              <optgroup label="Saved custom presets">
                {presets.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </optgroup>
            )}
          </select>
        </label>
        {dimensions &&
          (["minimum", "maximum"] as const).map((key) => {
            const label = `${key === "minimum" ? "Minimum" : "Maximum"} ${dipole ? "adjustable section per arm" : "mast length"} (${unit})`;
            return (
              <label key={key}>
                {label}
                <input
                  type="text"
                  inputMode="decimal"
                  maxLength={16}
                  aria-label={label}
                  aria-invalid={!!limits.error}
                  aria-describedby={`${id}-limits-note`}
                  placeholder="Optional"
                  value={preferences[key]}
                  onChange={(e) => edit({ [key]: e.currentTarget.value })}
                />
              </label>
            );
          })}
        {dipole && (
          <label>
            Fixed feed section per arm ({unit})
            <input
              type="text"
              inputMode="decimal"
              maxLength={16}
              aria-label={`Fixed feed section per arm (${unit})`}
              aria-invalid={fixed === undefined}
              aria-describedby={`${id}-limits-note`}
              value={preferences.fixedSection}
              onChange={(e) => edit({ fixedSection: e.currentTarget.value })}
            />
          </label>
        )}
      </div>
      {dimensions && (
        <p id={`${id}-limits-note`} className="antenna-small">
          {limits.error ??
            (dipole && fixed === undefined
              ? "Enter a non-negative fixed feed section up to 1,000 m."
              : (model?.note ??
                (dipole
                  ? "Each full arm equals its adjustable section plus the fixed feed section. Use zero if the adjustable-section measurement already starts at the feed point. Enter equal limits for both arms; leave unknown limits empty."
                  : "Optional: enter the exposed metal mast's minimum and maximum extension. Exclude the base, connector and cable. Leave unknown limits empty.")))}
        </p>
      )}
      {model && (
        <p className="antenna-small">
          <a href={model.url} target="_blank" rel="noopener noreferrer">
            {model.id === "ant500"
              ? "ANT500 manufacturer specifications"
              : `${model.name} · source & measurement notes`}
          </a>{" "}
          · {model.date} · reviewed 19 October 2026.
          {(model.id === "rtl-long" || model.id === "rtl-short") && (
            <>
              {" "}
              <a
                href="https://www.rtl-sdr.com/using-our-new-dipole-antenna-kit/"
                target="_blank"
                rel="noopener noreferrer"
              >
                Internal-metal measurement convention
              </a>
              .
            </>
          )}
        </p>
      )}
      {whip && (
        <label className="antenna-eighth-toggle">
          <input
            type="checkbox"
            checked={preferences.showEighth}
            onChange={(e) => onChange({ showEighth: e.currentTarget.checked })}
          />{" "}
          Show eighth-wave experiment
        </label>
      )}
      <details className="antenna-custom-manager">
        <summary>Save & manage custom presets</summary>
        <p className="antenna-small">
          Save this antenna type and its dimensions locally in this browser. Up
          to {MAX_CUSTOM_PRESETS} named presets. A saved profile is not a
          reception measurement.
        </p>
        <label>
          Custom preset name
          <input
            type="text"
            aria-label="Custom preset name"
            maxLength={48}
            value={name}
            placeholder="e.g. Desk dipole"
            onChange={(e) => onName(e.currentTarget.value)}
          />
        </label>
        <div className="antenna-custom-actions">
          <button
            type="button"
            className="secondary"
            onClick={() => onSave(false)}
          >
            Save as new preset
          </button>
          {saved && (
            <>
              <button
                type="button"
                className="secondary"
                onClick={() => onSave(true)}
              >
                Update preset
              </button>
              <button type="button" className="secondary" onClick={onDelete}>
                Delete preset
              </button>
            </>
          )}
          {canUndo && (
            <button type="button" className="secondary" onClick={onUndo}>
              Undo delete
            </button>
          )}
        </div>
        {status && (
          <p className="antenna-small" aria-live="polite">
            {status}
          </p>
        )}
      </details>
    </fieldset>
  );
}

export function DipoleLengths({
  frequencyHz,
  preferences,
  units,
  onSelect,
}: {
  frequencyHz: number;
  preferences: WhipPreferences;
  units: AntennaUnits;
  onSelect: (id: string) => void;
}) {
  const lengths = antennaLengths(frequencyHz),
    fixed = fixedSectionM(preferences, units);
  const label = (m: number) => antennaLengthLabel(m, units);
  const extension =
    fixed === undefined ? undefined : lengths.practicalArmM - fixed;
  const other =
    preferences.originPreset === "rtl-long"
      ? builtinPreset("rtl-short")
      : preferences.originPreset === "rtl-short"
        ? builtinPreset("rtl-long")
        : undefined;
  const otherFits =
    other &&
    extension !== undefined &&
    "minimumM" in other &&
    "maximumM" in other &&
    extension >= other.minimumM &&
    extension <= other.maximumM;
  return (
    <div className="antenna-dipole-lengths">
      <div className="antenna-whip-length">
        <span>Practical starting length · each full arm</span>
        <strong>{label(lengths.practicalArmM)}</strong>
        <span>
          {label(lengths.practicalDipoleM)} total span · two equal arms
        </span>
      </div>
      {extension === undefined ? (
        <p className="antenna-advisory">
          Correct the fixed feed section before checking extension fit.
        </p>
      ) : extension <= 0 ? (
        <p className="antenna-advisory">
          The target arm is shorter than the fixed feed section. Choose a
          different element set or design.
        </p>
      ) : (
        <>
          <p className="antenna-extension-target">
            Adjustable section: <strong>{label(extension)} per arm</strong>
            {fixed! > 0
              ? ` + ${label(fixed!)} fixed section`
              : " · measured from the feed point"}
            . Adjust both arms equally.
          </p>
          <WhipFit
            lengthM={extension}
            preferences={preferences}
            units={units}
            dipole
          />
          {otherFits &&
            whipFit(
              extension,
              parseWhipLimits(preferences.minimum, preferences.maximum, units),
            ) !== "fits" && (
              <button
                type="button"
                className="secondary"
                onClick={() => onSelect(other.id)}
              >
                Use {other.id === "rtl-short" ? "short" : "long"} elements
              </button>
            )}
        </>
      )}
      <p className="antenna-small">
        Ideal free-space reference: {label(lengths.quarterWaveM)} per arm,{" "}
        {label(lengths.halfWaveM)} total. The practical estimate and
        fixed-section allowance are starting points, not guaranteed tuning.
      </p>
    </div>
  );
}

export function PresetBandNote({
  frequencyHz,
  preferences,
}: {
  frequencyHz: number;
  preferences: WhipPreferences;
}) {
  const model = builtinPreset(preferences.originPreset);
  return model &&
    "range" in model &&
    (frequencyHz < model.range[0] || frequencyHz > model.range[1]) ? (
    <p className="antenna-advisory">
      Outside {model.id === "ratlsnake" ? "RaTLSnake" : model.id.toUpperCase()}
      's advertised {model.range[0] / 1e6}–{model.range[1] / 1e6} MHz range. A
      calculated length does not establish antenna coverage.
    </p>
  ) : null;
}

export function WhipFit({
  lengthM,
  preferences,
  units,
  dipole = false,
}: {
  lengthM: number;
  preferences: WhipPreferences;
  units: AntennaUnits;
  dipole?: boolean;
}) {
  const limits = parseWhipLimits(
    preferences.minimum,
    preferences.maximum,
    units,
  );
  const fit = whipFit(lengthM, limits);
  const published = !!builtinPreset(
    preferences.originPreset || preferences.preset,
  );
  const reference = published ? "published envelope" : "entered limits";
  return (
    <p className="antenna-fit" data-fit={fit} aria-live="polite">
      {fit === "invalid"
        ? "Length fit unavailable: correct the limits above."
        : fit === "unknown"
          ? "Add length limits above to check whether this target can be reached."
          : fit === "too-long"
            ? `Target exceeds the ${published ? "published" : "entered"} maximum of ${antennaLengthLabel(limits.maximumM!, units)}. ${dipole ? "Adjust both arms equally; use another element set if it cannot reach the target." : "Try the maximum available extension and compare reception; halving the length is not automatically better."}`
            : fit === "too-short"
              ? `Target is below the ${published ? "published" : "entered"} minimum of ${antennaLengthLabel(limits.minimumM!, units)}. ${dipole ? "Use a shorter element set and adjust both arms equally." : "Try the shortest available extension and compare reception; do not force the mast shorter."}`
              : `Target is within the ${reference}${limits.minimumM === undefined || limits.maximumM === undefined ? "; the other limit is unknown" : ""}${published ? (dipole ? "; confirm both arm measurements and the fixed-section allowance" : "; confirm the actual exposed mast measurement") : "; compare reception around this starting length"}.`}
    </p>
  );
}

export function DesignConcept({ design }: { design: SelectedAntenna }) {
  const title =
    design === "discone"
      ? "Discone: disc above cone, coax at central feed"
      : design === "turnstile"
        ? "Turnstile: two crossed dipoles, fed 90 degrees apart"
        : design === "yagi"
          ? "Yagi: reflector, driven element and directors along a boom"
          : "Log-periodic dipole array: scaled elements with alternating feed, aim toward short elements";
  return (
    <figure className="antenna-drawing antenna-design-concept">
      <svg
        viewBox="0 0 500 260"
        role="img"
        aria-label={`${title}. Concept only; no build dimensions.`}
      >
        <text x="250" y="25" textAnchor="middle" className="antenna-svg-muted">
          {design === "log-periodic"
            ? "LOG-PERIODIC DIPOLE ARRAY"
            : design.toUpperCase()}{" "}
          · CONCEPT
        </text>
        {design === "discone" ? (
          <>
            <ellipse
              cx="250"
              cy="77"
              rx="100"
              ry="13"
              className="antenna-radials"
            />
            <path
              d="M250 96L136 205 M250 96L190 214 M250 96V218 M250 96L310 214 M250 96L364 205 M136 205Q250 239 364 205"
              className="antenna-element"
            />
            <path d="M250 92V236" className="antenna-feed" />
            <text x="365" y="80">
              Disc
            </text>
            <text x="370" y="170">
              Cone
            </text>
          </>
        ) : design === "turnstile" ? (
          <>
            <path
              d="M95 70L235 140 M265 155L405 225"
              className="antenna-element"
            />
            <path
              d="M95 225L235 155 M265 140L405 70"
              className="antenna-radials"
            />
            <circle cx="250" cy="147" r="7" />
            <text x="90" y="55">
              Dipole A · 0°
            </text>
            <text x="290" y="55">
              Dipole B · 90°
            </text>
            <text
              x="250"
              y="250"
              textAnchor="middle"
              className="antenna-svg-muted"
            >
              Phase relationship · not a crossing-wire joint
            </text>
          </>
        ) : (
          <>
            <path d="M72 145H400" className="antenna-feed" />
            {(design === "yagi"
              ? [92, 80, 63, 57, 50]
              : [95, 78, 63, 50, 39, 30, 23]
            ).map((size, i) => (
              <path
                key={i}
                d={`M${95 + i * 43} ${145 - size}V${145 + size}`}
                className={i === 1 ? "antenna-element" : "antenna-radials"}
              />
            ))}
            {design === "yagi" && (
              <>
                <text x="56" y="250" className="antenna-svg-muted">
                  Reflector
                </text>
                <text x="139" y="46" className="antenna-svg-muted">
                  Driven
                </text>
                <text x="244" y="250" className="antenna-svg-muted">
                  Directors
                </text>
              </>
            )}
            <path
              d="M382 82H445L432 73 M445 82L432 91"
              className="antenna-element"
            />
            <text
              x="417"
              y="114"
              textAnchor="middle"
              className="antenna-svg-muted"
            >
              Aim
            </text>
            {design === "log-periodic" && (
              <text
                x="250"
                y="250"
                textAnchor="middle"
                className="antenna-svg-muted"
              >
                Alternating feed connections required
              </text>
            )}
          </>
        )}
      </svg>
      <figcaption>
        Illustrates the antenna form. Use a complete design or manufacturer
        dimensions for the intended band; no element lengths or feed network are
        calculated here.
      </figcaption>
    </figure>
  );
}

export function DesignSources() {
  return (
    <details className="antenna-details">
      <summary>Antenna design sources</summary>
      <p>
        Reviewed 19 October 2026; publication dates unknown unless stated.
        Concept drawings explain the forms and are not construction plans.
      </p>
      <ul>
        <li>
          <a
            href="https://www.arrl.org/vhf-and-uhf"
            target="_blank"
            rel="noopener noreferrer"
          >
            ARRL · ground-plane and directional antennas
          </a>
        </li>
        <li>
          <a
            href="https://www.antenna-theory.com/antennas/wideband/log-periodic-dipole.php"
            target="_blank"
            rel="noopener noreferrer"
          >
            Antenna Theory · log-periodic dipole arrays
          </a>
        </li>
        <li>
          <a
            href="https://www.diamondantenna.net/static/pdfdocs/D130J.pdf"
            target="_blank"
            rel="noopener noreferrer"
          >
            Diamond · example discone assembly
          </a>
        </li>
        <li>
          <a
            href="https://www.rtl-sdr.com/wp-content/uploads/2017/05/The-world-of-low-cost-software-defined-radio_2.pdf"
            target="_blank"
            rel="noopener noreferrer"
          >
            RTL-SDR Blog · QFH, turnstile and V-dipole concepts
          </a>{" "}
          · hosted May 2017, exact publication date unknown; historical examples
          do not establish current satellite availability.
        </li>
        <li>
          <a
            href="https://www.arrl.org/files/file/History/History%20of%20QST%20Volume%201%20-%20Technology/QS03-73-Sevick_opt.pdf"
            target="_blank"
            rel="noopener noreferrer"
          >
            ARRL · shortened verticals and matching
          </a>{" "}
          · March 1973.
        </li>
      </ul>
    </details>
  );
}

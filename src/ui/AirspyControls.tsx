import { airspyGainStages } from "../radio/airspyGain";
import {
  type AirspySettings,
  type AirspySessionDetails,
} from "../radio/airspySettings";
export function AirspyControls({
  settings,
  onChange,
  onApply,
  connected,
  busy,
  accepted,
}: {
  settings: AirspySettings;
  onChange: (settings: AirspySettings) => void;
  onApply: () => void;
  connected: boolean;
  busy: boolean;
  accepted?: AirspySessionDetails;
}) {
  const change = (next: Partial<AirspySettings>) =>
    onChange({ ...settings, ...next });
  const stages = airspyGainStages(settings);
  return (
    <div className="gain-control airspy-controls">
      <p>
        {accepted
          ? `Detected Airspy ${accepted.identity.rateProfile === "r2" ? "R2 rate profile" : "Mini rate profile"} · ${accepted.identity.firmware}`
          : "R2 / Mini is detected on connection. Connect to discover its supported sample rates."}
      </p>
      <label>
        Gain mode
        <select
          aria-label="Gain mode"
          value={settings.gainMode}
          disabled={busy}
          onChange={(event) =>
            change({
              gainMode: event.currentTarget.value as AirspySettings["gainMode"],
            })
          }
        >
          <option value="linearity">Linearity · strong-signal headroom</option>
          <option value="sensitivity">Sensitivity · weak signals</option>
          <option value="manual">Manual · individual stages</option>
        </select>
      </label>
      {settings.gainMode !== "manual" && (
        <label>
          Gain preset
          <select
            aria-label="Airspy gain preset"
            value={settings.gain}
            disabled={busy}
            onChange={(event) =>
              change({ gain: Number(event.currentTarget.value) })
            }
          >
            {Array.from({ length: 22 }, (_, value) => (
              <option key={value} value={value}>
                {value}
              </option>
            ))}
          </select>
        </label>
      )}
      {(
        [
          ["lna", "LNA gain", 14],
          ["mixer", "Mixer gain", 15],
          ["vga", "VGA / IF gain", 15],
        ] as const
      ).map(([key, label, max]) => (
        <label key={key}>
          {label}
          <select
            aria-label={label}
            value={settings.gainMode === "manual" ? settings[key] : stages[key]}
            disabled={
              busy ||
              settings.gainMode !== "manual" ||
              (key === "lna" && settings.lnaAgc) ||
              (key === "mixer" && settings.mixerAgc)
            }
            onChange={(event) =>
              change({ [key]: Number(event.currentTarget.value) })
            }
          >
            {Array.from({ length: max + 1 }, (_, value) => (
              <option key={value} value={value}>
                {value}
              </option>
            ))}
          </select>
        </label>
      ))}
      {(
        [
          ["lnaAgc", "LNA AGC"],
          ["mixerAgc", "Mixer AGC"],
        ] as const
      ).map(([key, label]) => (
        <label key={key} className="checkbox-control">
          <span>{label}</span>
          <input
            type="checkbox"
            checked={settings.gainMode === "manual" && settings[key]}
            disabled={busy || settings.gainMode !== "manual"}
            onChange={(event) => change({ [key]: event.currentTarget.checked })}
          />
        </label>
      ))}
      <small>
        Stage indices are not dB. Preset modes set all three stages and disable
        both AGCs.
      </small>
      <label>
        Conversion filter
        <select
          aria-label="Conversion filter"
          value={settings.conversionFilter}
          disabled={busy}
          onChange={(event) =>
            change({
              conversionFilter: event.currentTarget
                .value as AirspySettings["conversionFilter"],
            })
          }
        >
          <option value="standard">Standard · Airspy 47-tap FIR</option>
          <option value="sharp">Sharp · 95-tap Blackman FIR</option>
        </select>
      </label>
      <label>
        Decimation
        <select
          aria-label="Decimation"
          value={settings.decimation}
          disabled={busy}
          onChange={(event) =>
            change({
              decimation: Number(
                event.currentTarget.value,
              ) as AirspySettings["decimation"],
            })
          }
        >
          {[1, 2, 4, 8, 16, 32, 64].map((value) => (
            <option key={value} value={value}>
              {value === 1 ? "None" : `÷ ${value}`}
            </option>
          ))}
        </select>
      </label>
      <small>
        Decimation filters and narrows the captured spectrum. Wide modes require
        enough remaining bandwidth. The tuner's RF tracking and IF filters
        follow tuning and the device rate automatically.
      </small>
      <label>
        Frequency correction (ppm)
        <input
          type="number"
          min="-100"
          max="100"
          step="0.1"
          value={settings.ppm}
          disabled={busy}
          onChange={(event) => {
            if (
              event.currentTarget.validity.valid &&
              event.currentTarget.value !== ""
            )
              change({ ppm: event.currentTarget.valueAsNumber });
          }}
        />
      </label>
      <label className="checkbox-control">
        <span>12-bit USB packing</span>
        <input
          type="checkbox"
          checked={settings.packing}
          disabled={busy}
          onChange={(event) => change({ packing: event.currentTarget.checked })}
        />
      </label>
      <small>
        Packing reduces USB traffic by 25% and preserves all 12 ADC bits.
      </small>
      <label className="checkbox-control">
        <span>Bias tee · 4.5 V antenna power</span>
        <input
          type="checkbox"
          checked={settings.biasTee}
          disabled={busy}
          onChange={(event) => change({ biasTee: event.currentTarget.checked })}
        />
      </label>
      <small>
        Enable only for a compatible powered antenna or accessory. Defaults off
        for every new connection and turns off on Stop.
      </small>
      {connected && (
        <button
          type="button"
          className="secondary"
          disabled={busy}
          onClick={onApply}
        >
          Apply Airspy settings
        </button>
      )}
      {connected && (
        <small>
          Apply restarts reception with a brief gap. Active recordings finish
          with their original settings.
        </small>
      )}
      {accepted && (
        <small aria-label="Applied Airspy settings">
          Applied: {(accepted.deviceSampleRateHz / 1e6).toFixed(3)} MS/s device
          · {(accepted.outputSampleRateHz / 1e6).toFixed(6)} MS/s I/Q ·{" "}
          {accepted.settings.gainMode} · {accepted.settings.conversionFilter}{" "}
          filter · packing {accepted.settings.packing ? "on" : "off"} · antenna
          power {accepted.settings.biasTee ? "on" : "off"}.
        </small>
      )}
    </div>
  );
}

import {
  BLADERF_GAIN_MODES,
  bladeRfGainRange,
  type BladeRfGainMode,
  type BladeRfRxSettings,
} from "../radio/bladerfSettings";
import type { BladeRfSessionDetails } from "../radio/bladerfProtocol";

export function BladeRfControls({
  settings,
  onChange,
  onApply,
  connected,
  busy,
  frequencyHz,
  accepted,
}: {
  settings: BladeRfRxSettings;
  onChange(settings: BladeRfRxSettings): void;
  onApply(): void;
  connected: boolean;
  busy: boolean;
  frequencyHz: number;
  accepted?: BladeRfSessionDetails;
}) {
  const range = bladeRfGainRange(
    Number.isFinite(frequencyHz) &&
      frequencyHz >= 70_000_000 &&
      frequencyHz <= 6_000_000_000
      ? frequencyHz
      : 100_000_000,
  );
  const validGain =
    Number.isInteger(settings.manualGainDb) &&
    settings.manualGainDb >= range.min &&
    settings.manualGainDb <= range.max;
  return (
    <fieldset className="device-setup-details bladerf-controls" disabled={busy}>
      <legend>bladeRF receive controls</legend>
      <label>
        Receive input
        <select
          aria-label="bladeRF receive input"
          value={settings.rxInput}
          onChange={(e) =>
            onChange({
              ...settings,
              rxInput: e.currentTarget.value as BladeRfRxSettings["rxInput"],
            })
          }
        >
          <option value="RX1">RX1 · first antenna</option>
          <option value="RX2">RX2 · second antenna</option>
        </select>
      </label>
      <label>
        Gain mode
        <select
          aria-label="bladeRF gain mode"
          value={settings.gainMode}
          onChange={(e) =>
            onChange({
              ...settings,
              gainMode: e.currentTarget.value as BladeRfGainMode,
            })
          }
        >
          {Object.entries(BLADERF_GAIN_MODES).map(([mode, value]) => (
            <option key={mode} value={mode}>
              {value.label}
            </option>
          ))}
        </select>
      </label>
      {settings.gainMode === "manual" && (
        <label>
          Manual receiver gain (dB)
          <input
            aria-label="bladeRF manual gain"
            type="number"
            min={range.min}
            max={range.max}
            step={1}
            value={
              Number.isFinite(settings.manualGainDb)
                ? settings.manualGainDb
                : ""
            }
            onChange={(e) =>
              onChange({
                ...settings,
                manualGainDb: e.currentTarget.valueAsNumber,
              })
            }
          />
          <small>
            {range.min} to {range.max} dB at this RF center. Receiver gain is
            not calibrated signal power.
          </small>
        </label>
      )}
      {!validGain && (
        <p role="alert">
          Choose an integer gain from {range.min} to {range.max} dB.
        </p>
      )}
      <button
        type="button"
        disabled={!connected || !validGain}
        onClick={onApply}
      >
        Apply bladeRF RX settings
      </button>
      <small>
        One antenna input at a time. Applying briefly restarts reception. Fast
        and hybrid AGC are advanced options.
      </small>
      {accepted && (
        <p role="status" aria-label="Accepted bladeRF RX settings">
          Active: {accepted.rxInput ?? "RX1"} ·{" "}
          {BLADERF_GAIN_MODES[accepted.gainMode].label}
          {accepted.gainMode === "manual"
            ? ` · ${accepted.acceptedGainDb} dB readback`
            : " · gain varies automatically"}
        </p>
      )}
    </fieldset>
  );
}

import {
  RTTY_PRESETS,
  type TextMode,
  type TextModemSettings,
} from "../textmodem/settings";
export function TextModemControls({
  mode,
  settings,
  disabled,
  onChange,
}: {
  mode: TextMode;
  settings: TextModemSettings;
  disabled: boolean;
  onChange: (settings: TextModemSettings) => void;
}) {
  return (
    <fieldset className="text-modem-controls" disabled={disabled}>
      <legend>{mode === "PSK31" ? "BPSK31" : mode} reception settings</legend>
      <p className="support-copy">
        {mode === "RTTY"
          ? "Tune the midpoint between both RF tones. DWD: 50 baud / 450 Hz; amateur: 45.45 baud / 170 Hz. HF reception needs a suitable input and antenna."
          : mode === "PSK31"
            ? "31.25 baud BPSK only. Tune the RF carrier; fine offset and carrier tracking help align a narrow signal. Decoded text has no checksum."
            : mode === "NAVTEX"
              ? "100 baud / 170 Hz CCIR476 with delayed-copy FEC. Tune the two-tone midpoint. Suitable LF/HF input required. Message headers do not establish transmitter identity."
              : "Single VHF AM channel · 2400 bit/s MSK. Only CRC- and parity-valid blocks enter the message list. VDL2 is a separate mode."}
      </p>
      {mode !== "ACARS" && (
        <label>
          Fine tuning offset (Hz)
          <input
            aria-label="Text modem fine tuning offset"
            type="number"
            min={-3000}
            max={3000}
            step={1}
            value={settings.tuningOffsetHz}
            onChange={(e) => {
              const value = Number(e.target.value);
              if (Number.isFinite(value) && Math.abs(value) <= 3000)
                onChange({ ...settings, tuningOffsetHz: value });
            }}
          />
        </label>
      )}
      {mode === "RTTY" && (
        <>
          <div className="button-row">
            <button
              type="button"
              className="secondary"
              onClick={() => onChange({ ...settings, ...RTTY_PRESETS.dwd })}
            >
              DWD 50 / 450
            </button>
            <button
              type="button"
              className="secondary"
              onClick={() => onChange({ ...settings, ...RTTY_PRESETS.amateur })}
            >
              Amateur 45.45 / 170
            </button>
          </div>
          <label>
            RTTY baud
            <select
              value={settings.baud}
              onChange={(e) =>
                onChange({
                  ...settings,
                  baud: Number(e.target.value) as TextModemSettings["baud"],
                })
              }
            >
              {[45.45, 50, 75].map((value) => (
                <option key={value}>{value}</option>
              ))}
            </select>
          </label>
          <label>
            RTTY shift (Hz)
            <select
              value={settings.shiftHz}
              onChange={(e) =>
                onChange({
                  ...settings,
                  shiftHz: Number(
                    e.target.value,
                  ) as TextModemSettings["shiftHz"],
                })
              }
            >
              {[170, 450, 850].map((value) => (
                <option key={value}>{value}</option>
              ))}
            </select>
          </label>
          <label>
            RTTY stop bits
            <select
              value={settings.stopBits}
              onChange={(e) =>
                onChange({
                  ...settings,
                  stopBits: Number(
                    e.target.value,
                  ) as TextModemSettings["stopBits"],
                })
              }
            >
              {[1, 1.5, 2].map((value) => (
                <option key={value}>{value}</option>
              ))}
            </select>
          </label>
        </>
      )}
      {(mode === "RTTY" || mode === "NAVTEX") && (
        <label className="checkbox-label">
          <input
            type="checkbox"
            checked={settings.inverted}
            onChange={(e) =>
              onChange({ ...settings, inverted: e.target.checked })
            }
          />
          Reverse mark / space
        </label>
      )}
    </fieldset>
  );
}

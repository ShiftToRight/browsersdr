import { InstrumentRange } from "./InstrumentRange";
import { useState } from "react";
import {
  RTTY_PRESETS,
  DEFAULT_CW_SETTINGS, DEFAULT_IMAGE_SETTINGS,
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
  const image = settings.image ?? DEFAULT_IMAGE_SETTINGS;
  const cw = settings.cw ?? DEFAULT_CW_SETTINGS;
  const [offsetDraft, setOffsetDraft] = useState<{ mode: TextMode; accepted: number; value: string }>();
  const offsetValue = offsetDraft?.mode === mode && offsetDraft.accepted === settings.tuningOffsetHz
    ? offsetDraft.value : String(settings.tuningOffsetHz);
  const offsetLimit = mode === "WEFAX" || mode === "SSTV" ? 1500 : 3000;
  const offsetHz = offsetValue.trim() ? Number(offsetValue) : NaN;
  const offsetValid = Number.isInteger(offsetHz) && Math.abs(offsetHz) <= offsetLimit;
  const commitOffset = () => {
    if (disabled || !offsetValid) return;
    if (offsetHz !== settings.tuningOffsetHz) onChange({ ...settings, tuningOffsetHz: offsetHz });
    setOffsetDraft(undefined);
  };
  return (
    <fieldset className="text-modem-controls" disabled={disabled}>
      <legend>{mode === "PSK31" ? "BPSK31" : mode === "CW-TEXT" ? "CW + text assistant" : mode} reception settings</legend>
      <p className="support-copy">
        {mode === "WEFAX" ? "USB weather-fax input, centered at 1,900 Hz audio. Automatic APT/phasing; choose Manual to start at the current input. Suitable HF input and antenna required."
          : mode === "SSTV" ? "Martin M1/M2 color pictures. Auto validates VIS parity and rejects unsupported modes; choose a Martin mode to join an image without its header. USB input; no other SSTV modes yet."
          : mode === "CW-TEXT" ? "Optional Morse transcription with the CW audio monitor. Tune the keyed carrier, set an initial speed and adjust the relative threshold; all text is tentative. Select ordinary CW for audio alone."
          : mode === "RTTY"
          ? "Tune the midpoint between both RF tones. DWD: 50 baud / 450 Hz; amateur: 45.45 baud / 170 Hz. HF reception needs a suitable input and antenna."
          : mode === "PSK31"
            ? "31.25 baud BPSK only. Tune the RF carrier; fine offset and carrier tracking help align a narrow signal. Decoded text has no checksum."
            : mode === "NAVTEX"
              ? "100 baud / 170 Hz CCIR476 with delayed-copy FEC. Tune the two-tone midpoint. Suitable LF/HF input required. Message headers do not establish transmitter identity."
              : "Single VHF AM channel · 2400 bit/s MSK. Only CRC- and parity-valid blocks enter the message list. VDL2 is a separate mode."}
      </p>
      {mode !== "ACARS" && mode !== "CW-TEXT" && (
        <label>
          Fine tuning offset (Hz)
          <input
            aria-label="Text modem fine tuning offset"
            type="number"
            min={-offsetLimit}
            max={offsetLimit}
            step={1}
            value={offsetValue}
            aria-invalid={!offsetValid}
            aria-describedby="text-modem-offset-help"
            onChange={(e) => setOffsetDraft({ mode, accepted: settings.tuningOffsetHz, value: e.currentTarget.value })}
            onBlur={commitOffset}
            onKeyDown={(e) => {
              if (e.key === "Enter") { e.preventDefault(); commitOffset(); }
              if (e.key === "Escape") { e.preventDefault(); setOffsetDraft(undefined); }
            }}
          />
          <small id="text-modem-offset-help">{offsetValid ? "Apply with Enter or leave the field; Escape cancels." : `Enter a whole-Hz offset from −${offsetLimit} to ${offsetLimit}.`}</small>
        </label>
      )}
      {mode === "WEFAX" && <>
        <label>WEFAX reception<select aria-label="WEFAX reception" value={image.automatic ? "auto" : "manual"} onChange={e => onChange({ ...settings, image: { ...image, automatic: e.target.value === "auto" } })}><option value="auto">Automatic APT / phasing</option><option value="manual">Manual · start here</option></select></label>
        <label>Index of cooperation<select value={image.ioc} onChange={e => onChange({ ...settings, image: { ...image, ioc: Number(e.target.value) as 288 | 576, lpm: e.target.value === "288" ? 60 : 120 } })}><option value={576}>IOC 576</option><option value={288}>IOC 288</option></select></label>
        <label>WEFAX lines per minute<select value={image.lpm} onChange={e => onChange({ ...settings, image: { ...image, lpm: Number(e.target.value) as typeof image.lpm } })}>{[60, 90, 120, 240].map(value => <option key={value}>{value}</option>)}</select></label>
        <label>WEFAX shift (Hz)<select value={image.shiftHz} onChange={e => onChange({ ...settings, image: { ...image, shiftHz: Number(e.target.value) as 800 | 850 } })}><option>800</option><option>850</option></select></label>
      </>}
      {mode === "SSTV" && <label>SSTV image mode<select value={image.sstvMode} onChange={e => onChange({ ...settings, image: { ...image, sstvMode: e.target.value as typeof image.sstvMode } })}><option value="auto">Automatic VIS</option><option>Martin M1</option><option>Martin M2</option></select></label>}
      {mode === "CW-TEXT" && <>
        <label>CW text speed (WPM)<input aria-label="CW text speed" type="number" min={5} max={60} step={1} value={cw.wpm} onChange={e => { const value = Number(e.target.value); if (value >= 5 && value <= 60) onChange({ ...settings, cw: { ...cw, wpm: value } }); }} /></label>
        <label className="checkbox-label"><input type="checkbox" checked={cw.autoSpeed} onChange={e => onChange({ ...settings, cw: { ...cw, autoSpeed: e.target.checked } })} />Track CW speed</label>
        <label>CW relative threshold<InstrumentRange aria-label="CW relative threshold"  min={0.1} max={0.8} step={0.05} value={cw.threshold} onChange={e => onChange({ ...settings, cw: { ...cw, threshold: Number(e.target.value) } })} /><output>{cw.threshold.toFixed(2)}</output></label>
      </>}
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
      <button type="button" className="secondary" onClick={() => onChange({ ...settings })}>Restart decoder</button>
      <small>Changing reception settings or restarting begins a new decoder segment. Export the current result first.</small>
    </fieldset>
  );
}

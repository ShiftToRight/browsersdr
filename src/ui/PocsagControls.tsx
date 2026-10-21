import type { PocsagSettings } from "../pocsag/settings";
export function PocsagControls({
  settings,
  disabled,
  onChange,
}: {
  settings: PocsagSettings;
  disabled: boolean;
  onChange: (next: PocsagSettings) => void;
}) {
  return (
    <div
      className="mode-primary-controls"
      aria-label="POCSAG reception settings"
    >
      <label>
        POCSAG bit rate
        <select
          disabled={disabled}
          value={settings.rate}
          onChange={(e) =>
            onChange({
              ...settings,
              rate:
                e.target.value === "auto"
                  ? "auto"
                  : (Number(e.target.value) as 512 | 1200 | 2400),
            })
          }
        >
          <option value="auto">Auto · 512 / 1200 / 2400</option>
          {[512, 1200, 2400].map((rate) => (
            <option key={rate} value={rate}>
              {rate} bit/s
            </option>
          ))}
        </select>
      </label>
      <label>
        POCSAG polarity
        <select
          disabled={disabled}
          value={settings.polarity}
          onChange={(e) =>
            onChange({
              ...settings,
              polarity: e.target.value as PocsagSettings["polarity"],
            })
          }
        >
          <option value="auto">Auto polarity</option>
          <option value="normal">Normal</option>
          <option value="inverted">Inverted</option>
        </select>
      </label>
      <label>
        Message interpretation
        <select
          disabled={disabled}
          value={settings.interpretation}
          onChange={(e) =>
            onChange({
              ...settings,
              interpretation: e.target
                .value as PocsagSettings["interpretation"],
            })
          }
        >
          <option value="function">By function</option>
          <option value="numeric">Numeric</option>
          <option value="alpha">Alphanumeric · US / IA5</option>
          <option value="raw">Raw payload bits</option>
        </select>
      </label>
      <label>
        Codeword correction
        <select
          disabled={disabled}
          value={settings.correction}
          onChange={(e) =>
            onChange({
              ...settings,
              correction: Number(e.target.value) as 0 | 1 | 2,
            })
          }
        >
          {[0, 1, 2].map((bits) => (
            <option key={bits} value={bits}>
              {bits === 0
                ? "Detect only"
                : `Up to ${bits} bit${bits === 1 ? "" : "s"}`}
            </option>
          ))}
        </select>
      </label>
      <p className="support-copy">
        Receive-only radio paging · tune the carrier midpoint. Complete framing
        and codeword correction do not verify message content or transmitter
        identity.
      </p>
    </div>
  );
}

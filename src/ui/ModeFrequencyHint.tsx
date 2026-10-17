import type { ReceiverMode } from "../radio/receiverConfig";

const CHANNELS: Partial<
  Record<ReceiverMode, { hz: number; label: string; explanation: string }>
> = {
  "ADS-B": {
    hz: 1_090_000_000,
    label: "1090 MHz",
    explanation: "1090ES uses 1090 MHz.",
  },
  AIS: {
    hz: 162_000_000,
    label: "162 MHz",
    explanation: "Center the dual-channel receiver between AIS 1 and AIS 2.",
  },
  DAB: {
    hz: 178_352_000,
    label: "DAB 5C",
    explanation:
      "Choose the local Band III block above. 5C is a starting point, not a reception claim.",
  },
  ACARS: {
    hz: 131_725_000,
    label: "131.725 MHz",
    explanation:
      "Example European ACARS channel; verify local traffic or choose another VHF ACARS channel.",
  },
  NAVTEX: {
    hz: 518_000,
    label: "518 kHz",
    explanation:
      "International NAVTEX uses 518 kHz; regional services also use other channels. A suitable LF input is required.",
  },
};

export function ModeFrequencyHint({
  mode,
  frequencyHz,
  disabled,
  onChoose,
}: {
  mode: ReceiverMode;
  frequencyHz: number;
  disabled: boolean;
  onChoose: (hz: number) => void;
}) {
  const suggestion = CHANNELS[mode];
  if (!suggestion) return null;
  const mismatch =
    mode === "DAB"
      ? frequencyHz < 174e6 || frequencyHz > 240e6
      : mode === "ACARS"
        ? frequencyHz < 118e6 || frequencyHz > 137e6
        : mode === "NAVTEX"
          ? ![518000, 490000, 4209500].includes(Math.round(frequencyHz))
          : Math.abs(frequencyHz - suggestion.hz) > 1;
  return (
    <div className="mode-frequency-hint">
      <small>
        {suggestion.explanation}{" "}
        {mismatch &&
          "The current frequency is outside this mode's suggested channel."}
      </small>
      {mismatch && (
        <button
          type="button"
          className="secondary"
          disabled={disabled}
          onClick={() => onChoose(suggestion.hz)}
        >
          Use {suggestion.label}
        </button>
      )}
    </div>
  );
}

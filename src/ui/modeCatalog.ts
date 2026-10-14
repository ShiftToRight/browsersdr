import type { ReceiverMode } from "../radio/receiverConfig";

export const MODE_CATEGORIES = [
  "All modes",
  "Broadcast",
  "Aviation",
  "Marine",
  "Amateur",
  "Sensors",
  "Weather & satellite",
] as const;
export type ModeCategory = (typeof MODE_CATEGORIES)[number];

interface ModeDescription {
  label: string;
  description: string;
  categories: readonly ModeCategory[];
  aliases: string;
}

/** Presentation metadata only. Persisted modes and DSP routing keep their existing IDs. */
export const MODE_DESCRIPTIONS: Record<ReceiverMode, ModeDescription> = {
  DAB: {
    label: "DAB / DAB+",
    description: "Digital broadcast radio",
    categories: ["Broadcast"],
    aliases: "digital audio broadcasting ensemble services",
  },
  "ADS-B": {
    label: "ADS-B 1090ES",
    description: "Aircraft positions",
    categories: ["Aviation"],
    aliases: "adsb aircraft airplane traffic mode s",
  },
  AIS: {
    label: "AIS",
    description: "Vessel messages",
    categories: ["Marine"],
    aliases: "ships boats automatic identification",
  },
  APRS: {
    label: "APRS",
    description: "Amateur packet radio",
    categories: ["Amateur"],
    aliases: "ax25 ax.25 bell 202 stations packets",
  },
  SRD: {
    label: "SRD",
    description: "Sensors & short-range devices",
    categories: ["Sensors"],
    aliases: "ook ask fsk ism telemetry",
  },
  RS41: {
    label: "RS41",
    description: "Radiosonde telemetry",
    categories: ["Weather & satellite"],
    aliases: "sonde weather balloon vaisala",
  },
  WBFM: {
    label: "WBFM",
    description: "FM broadcast audio & RDS",
    categories: ["Broadcast"],
    aliases: "wideband fm radio data system rbds",
  },
  NBFM: {
    label: "NBFM",
    description: "Narrowband FM voice",
    categories: ["Amateur"],
    aliases: "nfm repeaters two way radio",
  },
  AM: {
    label: "AM",
    description: "Amplitude-modulated audio",
    categories: ["Broadcast", "Aviation"],
    aliases: "mediumwave shortwave airband voice",
  },
  USB: {
    label: "USB",
    description: "Upper sideband audio",
    categories: ["Amateur", "Marine"],
    aliases: "ssb single sideband shortwave hf",
  },
  LSB: {
    label: "LSB",
    description: "Lower sideband audio",
    categories: ["Amateur"],
    aliases: "ssb single sideband shortwave hf",
  },
  CW: {
    label: "CW",
    description: "Morse audio with a beat tone",
    categories: ["Amateur"],
    aliases: "continuous wave morse code listening",
  },
  OFF: {
    label: "Spectrum only",
    description: "Spectrum without demodulation",
    categories: [],
    aliases: "off iq i/q recording no audio",
  },
};

export const CATALOG_MODES = Object.keys(MODE_DESCRIPTIONS) as ReceiverMode[];

export function matchingModes(
  query: string,
  category: ModeCategory,
): ReceiverMode[] {
  const words = query.toLowerCase().trim().split(/\s+/).filter(Boolean);
  return CATALOG_MODES.filter((mode) => {
    const info = MODE_DESCRIPTIONS[mode];
    const text =
      `${mode} ${info.label} ${info.description} ${info.aliases}`.toLowerCase();
    return (
      (category === "All modes" || info.categories.includes(category)) &&
      words.every((word) => text.includes(word))
    );
  });
}

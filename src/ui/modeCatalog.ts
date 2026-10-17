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
  WEFAX: { label: "WEFAX", description: "HF weather-fax chart images", categories: ["Weather & satellite", "Marine"], aliases: "radiofax weather fax image chart dwd ioc 576 288" },
  SSTV: { label: "SSTV", description: "Martin M1/M2 amateur color pictures", categories: ["Amateur"], aliases: "slow scan television image martin m1 m2 vis" },
  "CW-TEXT": { label: "CW + text", description: "Tentative Morse transcription with CW audio", categories: ["Amateur"], aliases: "morse cw text decode transcription wpm" },
  RTTY: { label: "RTTY", description: "DWD weather & amateur text", categories: ["Amateur", "Weather & satellite"], aliases: "baudot ita2 fsk radioteletype 50 baud 450 hz" },
  PSK31: { label: "BPSK31", description: "Amateur phase-shift text", categories: ["Amateur"], aliases: "psk31 bpsk varicode 31.25" },
  NAVTEX: { label: "NAVTEX / SITOR-B", description: "Marine weather & safety text", categories: ["Marine", "Weather & satellite"], aliases: "ccir476 fec 518 490 sitorb" },
  ACARS: { label: "ACARS", description: "Single-channel VHF aviation messages", categories: ["Aviation"], aliases: "aircraft aviation vhf am msk 2400" },
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
  const tokens = (text: string) => text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
  const words = tokens(query);
  const compact = words.join("");
  return CATALOG_MODES.map((mode, index) => {
    const info = MODE_DESCRIPTIONS[mode];
    const names = [mode, info.label].map(value => tokens(value).join(""));
    const searchable = tokens(`${mode} ${info.label} ${info.description} ${info.aliases}`);
    const matches = words.every(word => searchable.some(token => token.startsWith(word))) ||
      (compact.length > 0 && names.includes(compact));
    return {mode, index, score: compact && names.includes(compact) ? 0 : 1, matches};
  }).filter(({mode, matches}) => matches && (category === "All modes" || MODE_DESCRIPTIONS[mode].categories.includes(category)))
    .sort((a,b) => a.score - b.score || a.index - b.index).map(row => row.mode);
}

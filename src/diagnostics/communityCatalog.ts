export const COMMUNITY_HARDWARE = [
  { id: "rtl-nesdr-smart-v5", label: "NESDR SMArt v5", source: "rtl-sdr" },
  { id: "rtl-blog-v3", label: "RTL-SDR Blog V3", source: "rtl-sdr" },
  { id: "rtl-blog-v4", label: "RTL-SDR Blog V4", source: "rtl-sdr" },
  {
    id: "rtl-unknown",
    label: "RTL-SDR",
    source: "rtl-sdr",
  },
  { id: "hackrf-one", label: "HackRF One · experimental", source: "hackrf" },
  { id: "hackrf-pro", label: "HackRF Pro", source: "hackrf" },
  { id: "bladerf-xa4", label: "bladeRF xA4", source: "bladerf" },
  { id: "bladerf-xa5", label: "bladeRF xA5 · experimental", source: "bladerf" },
  { id: "bladerf-xa9", label: "bladeRF xA9 · experimental", source: "bladerf" },
  {
    id: "bladerf-unknown",
    label: "bladeRF · unknown variant",
    source: "bladerf",
  },
  { id: "usrp-b205-mini", label: "USRP B205-mini", source: "usrp-b205" },
  { id: "usrp-b205mini-i", label: "USRP B205mini-i", source: "usrp-b205" },
  { id: "usrp-unknown", label: "USRP · unknown variant", source: "usrp-b205" },
  { id: "replay", label: "I/Q replay", source: "replay" },
  { id: "synthetic", label: "Synthetic demo", source: "synthetic" },
] as const;

export const COMMUNITY_FEATURES = [
  { id: "wbfm", label: "FM audio", group: "analog", mode: "WBFM" },
  { id: "nbfm", label: "NBFM", group: "analog", mode: "NBFM" },
  { id: "am", label: "AM", group: "analog", mode: "AM" },
  { id: "usb", label: "USB", group: "analog", mode: "USB" },
  { id: "lsb", label: "LSB", group: "analog", mode: "LSB" },
  { id: "cw", label: "CW", group: "analog", mode: "CW" },
  { id: "rds", label: "RDS", group: "broadcast", mode: "WBFM" },
  {
    id: "dab-discovery",
    label: "DAB discovery",
    group: "broadcast",
    mode: "DAB",
  },
  { id: "dab-audio", label: "DAB audio", group: "broadcast", mode: "DAB" },
  {
    id: "dab-plus-audio",
    label: "DAB+ audio",
    group: "broadcast",
    mode: "DAB",
  },
  { id: "adsb", label: "ADS-B 1090", group: "data", mode: "ADS-B" },
  { id: "ais", label: "AIS", group: "data", mode: "AIS" },
  { id: "aprs", label: "APRS", group: "data", mode: "APRS" },
  { id: "rs41", label: "RS41", group: "data", mode: "RS41" },
  { id: "rtty", label: "RTTY text", group: "data", mode: "RTTY" },
  { id: "psk31", label: "BPSK31 text", group: "data", mode: "PSK31" },
  { id: "navtex", label: "NAVTEX / SITOR-B", group: "data", mode: "NAVTEX" },
  { id: "acars", label: "ACARS", group: "data", mode: "ACARS" },
  { id: "wefax", label: "WEFAX images", group: "data", mode: "WEFAX" },
  { id: "sstv", label: "SSTV Martin images", group: "data", mode: "SSTV" },
  { id: "cw-text", label: "CW text assistant", group: "data", mode: "CW-TEXT" },
  { id: "srd-acurite", label: "SRD Acurite", group: "data", mode: "SRD" },
  { id: "srd-wh51", label: "SRD WH51", group: "data", mode: "SRD" },
  {
    id: "access",
    label: "Connection / start / stop",
    group: "access",
    mode: null,
  },
  {
    id: "processing",
    label: "Worker + WASM processing",
    group: "runtime",
    mode: null,
  },
  {
    id: "audio-output",
    label: "Audio playback / resume",
    group: "runtime",
    mode: null,
  },
  {
    id: "display",
    label: "Spectrum / waterfall",
    group: "runtime",
    mode: null,
  },
  {
    id: "storage",
    label: "Recording / recovery",
    group: "runtime",
    mode: null,
  },
  { id: "export", label: "SigMF export", group: "workflow", mode: null },
  {
    id: "replay",
    label: "File import / replay",
    group: "workflow",
    mode: null,
  },
  { id: "tuning", label: "Tuning", group: "workflow", mode: null },
] as const;

export type CommunityHardwareId = (typeof COMMUNITY_HARDWARE)[number]["id"];

/** Presentation aliases only; historical wire IDs and evidence scopes stay intact. */
export function communityHardwareRowId(
  id: CommunityHardwareId,
): CommunityHardwareId {
  if (id.startsWith("rtl-")) return "rtl-unknown";
  return id === "usrp-b205-mini" ? "usrp-b205mini-i" : id;
}

export const COMMUNITY_REPORT_HARDWARE = COMMUNITY_HARDWARE.filter(
  (hardware) => communityHardwareRowId(hardware.id) === hardware.id,
);

export type CommunityFeatureId = (typeof COMMUNITY_FEATURES)[number]["id"];
export type CommunityGroup = (typeof COMMUNITY_FEATURES)[number]["group"];
export const COMMUNITY_GROUPS = [
  { id: "analog", label: "Analog audio" },
  { id: "broadcast", label: "Digital broadcast" },
  { id: "data", label: "Packet & data" },
  { id: "workflow", label: "Recording & replay" },
] as const;

export function defaultCommunityHardware(source: string, protocolProfile?: string | null): CommunityHardwareId {
  if (source === "hackrf") return protocolProfile === "hackrf-one-stable-2026-v1" ? "hackrf-one" : "hackrf-pro";
  return (
    COMMUNITY_HARDWARE.find(
      (h) => h.source === source && h.id.endsWith("unknown"),
    )?.id ??
    COMMUNITY_HARDWARE.find((h) => h.source === source)?.id ??
    "synthetic"
  );
}

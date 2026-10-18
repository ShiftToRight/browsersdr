import type { ReceiverMode } from "./receiverConfig";

export type AntennaGuideId =
  "fm" | "dab" | "adsb" | "ais" | "rs41" | "satellite";
export interface AntennaContext {
  frequencyHz?: number;
  mode?: ReceiverMode;
  sourceLabel: string;
  kind: "local" | "remote" | "replay" | "demo";
  range?: {
    minimumHz: number;
    maximumHz: number;
    limitsDiscoveredAtTune: boolean;
  };
}
export interface AntennaSource {
  label: string;
  url: string;
  date: string;
}
export interface AntennaGuideRecord {
  id: AntennaGuideId;
  name: string;
  band: string;
  frequencyHz: number;
  mode?: ReceiverMode;
  range: readonly [number, number];
  shape: "dipole" | "ground-plane" | "v-dipole";
  result: string;
  start: string;
  polarization: string;
  placement: string;
  tips: readonly string[];
  upgrade: string;
  capability: string;
  sources: readonly AntennaSource[];
}
const dipoleSource: AntennaSource = {
  label: "ARRL · dipole starting lengths",
  url: "https://www.arrl.org/single-band-dipoles",
  date: "Publication date unknown",
};
const kitSource: AntennaSource = {
  label: "RTL-SDR Blog · dipole kit instructions",
  url: "https://www.rtl-sdr.com/using-our-new-dipole-antenna-kit/",
  date: "2017 · historical satellite examples",
};
export const ANTENNA_GUIDES: readonly AntennaGuideRecord[] = [
  {
    id: "fm",
    name: "FM radio & RDS",
    band: "Broadcast FM",
    frequencyHz: 100e6,
    mode: "WBFM",
    range: [65e6, 108e6],
    shape: "dipole",
    result:
      "Listen to broadcast radio and recover RDS station text where transmitted and received clearly.",
    start:
      "An adjustable two-arm dipole. A quarter-wave whip with a suitable ground plane is another simple option.",
    polarization:
      "Match the broadcast polarization where known. Try the dipole vertically and horizontally; FM stations can use different polarizations.",
    placement:
      "Start near a clear window, away from USB cables, chargers and computer displays. Compare a few positions before adding gain.",
    tips: [
      "Measure each arm from the feed point; the coax is not part of the quoted arm length.",
      "A strong nearby FM station can overload the receiver. Try less gain if many false signals appear.",
      "Size for your chosen station. One length is not optimal across the entire FM band.",
    ],
    upgrade:
      "A dedicated outdoor FM antenna with suitable feedline, matched to your local broadcast polarization.",
    capability:
      "Built-in FM audio and RDS. Clear audio does not guarantee RDS recovery.",
    sources: [dipoleSource, kitSource],
  },
  {
    id: "dab",
    name: "DAB / DAB+ radio",
    band: "VHF Band III",
    frequencyHz: 225.648e6,
    mode: "DAB",
    range: [174e6, 240e6],
    shape: "dipole",
    result:
      "Receive an ensemble carrying several programmes, text and, where available, slideshow images.",
    start:
      "A dipole sized for the selected DAB block, or a dedicated Band III receiving antenna.",
    polarization:
      "Start with the elements vertical, a common DAB arrangement. Check the local transmitter's published polarization.",
    placement:
      "Try a higher, clearer position. Small changes in indoor placement can change digital reception substantially.",
    tips: [
      "Use the DAB block's center frequency, not an FM frequency for the same programme.",
      "Select a programme after the ensemble has been decoded.",
      "Use good cable and connectors; extra amplification cannot restore a missing or obstructed signal.",
    ],
    upgrade:
      "An outdoor Band III antenna; choose directional or omnidirectional coverage for your local transmitters.",
    capability:
      "Built-in DAB/DAB+ reception; DAB+ audio also depends on browser codec support. Legacy MP2 audio is unavailable.",
    sources: [
      dipoleSource,
      {
        label: "Lenco · DAB antenna orientation",
        url: "https://support.lenco.com/en/support/solutions/articles/48000313078-how-can-i-improve-the-reception-of-my-dab-radio-",
        date: "11 July 2019 · modified",
      },
    ],
  },
  {
    id: "adsb",
    name: "Aircraft · ADS-B",
    band: "1090 MHz · 1090ES",
    frequencyHz: 1090e6,
    mode: "ADS-B",
    range: [1089e6, 1091e6],
    shape: "ground-plane",
    result:
      "Decode supported aircraft broadcasts and plot reported positions when sufficient valid messages arrive.",
    start:
      "A vertical quarter-wave radiator over a ground plane, or a dedicated 1090 MHz receiving antenna.",
    polarization:
      "Keep the radiator vertical. An omnidirectional antenna covers aircraft in different directions.",
    placement:
      "Prioritize a clear view toward the horizon and sky. Buildings, terrain and feedline loss limit coverage.",
    tips: [
      "At 1090 MHz the radiator is only about 6.9 cm; measure carefully.",
      "Keep the coax short or use lower-loss cable, especially for an outdoor antenna.",
      "A band-pass filter or suitable LNA may help a diagnosed problem; more gain can also overload the input.",
    ],
    upgrade:
      "A dedicated outdoor 1090 MHz antenna and low-loss feedline; consider filtering after checking interference.",
    capability:
      "Built-in 1090ES decoder. 978 MHz UAT requires a different decoder and is unavailable here.",
    sources: [
      dipoleSource,
      {
        label: "FlightAware · antenna selection and placement",
        url: "https://support.flightaware.com/hc/en-us/articles/37945308579735-Antenna",
        date: "Publication date unknown",
      },
    ],
  },
  {
    id: "ais",
    name: "Ships · AIS",
    band: "Marine VHF · around 162 MHz",
    frequencyHz: 162e6,
    mode: "AIS",
    range: [161.9e6, 162.1e6],
    shape: "ground-plane",
    result:
      "Decode supported AIS vessel reports within radio range. Coverage depends on local traffic and the receiving site.",
    start:
      "A vertical marine VHF antenna, or a quarter-wave ground-plane antenna sized near 162 MHz.",
    polarization:
      "Keep the radiator vertical, as used for marine VHF installations.",
    placement:
      "Choose a clear view toward the water. Height and nearby obstructions matter more than a higher gain setting alone.",
    tips: [
      "A whip needs a ground plane or suitable counterpoise; a lone wire on coax is not a complete ground-plane design.",
      "Use the AIS channel selection in BrowserSDR; frequency alone is not a vessel identity.",
      "Check connectors and cable loss before adding an amplifier.",
    ],
    upgrade:
      "An outdoor marine VHF receiving antenna with suitable feedline and a clear view of the water.",
    capability:
      "Built-in AIS decoder and reported-position map. This guide is for reception.",
    sources: [
      dipoleSource,
      {
        label: "Garmin / Vesper · marine antenna installation",
        url: "https://static.garmin.com/pumac/Vesper_Marine_Cortex_Hub_Installation_Guide_English_DEC21_WEBv2.pdf",
        date: "December 2021 · installation guide",
      },
    ],
  },
  {
    id: "rs41",
    name: "Weather balloons · RS41",
    band: "400.15–406 MHz",
    frequencyHz: 403e6,
    mode: "RS41",
    range: [400.15e6, 406e6],
    shape: "ground-plane",
    result:
      "Decode supported radiosonde frames and reported positions when an active balloon is within range.",
    start:
      "A small vertical ground-plane antenna sized for the actual sonde frequency; 403 MHz is an example, not a universal channel.",
    polarization:
      "A vertical antenna is a practical starting point. Balloon motion and obstructions can still cause fading.",
    placement:
      "Find an open view of the sky and horizon; a higher clear position can help while the balloon is low.",
    tips: [
      "Find the actual local launch frequency; there may be no active sonde nearby.",
      "Use a radiator around 18.6 cm for the 403 MHz example, with a ground plane.",
      "A dedicated directional antenna can help follow a weak balloon, but needs aiming.",
    ],
    upgrade:
      "A purpose-built 400 MHz receiving antenna, or an aimed antenna for a specific balloon.",
    capability:
      "Built-in RS41 frame and position decoding. This does not promise calibrated weather measurements.",
    sources: [
      dipoleSource,
      {
        label: "Vaisala · RS41-SG technical data",
        url: "https://docs.vaisala.com/api/khub/documents/LD~wzzCT3_XBTpdY2K~jJw/content",
        date: "2024 · B211321EN-L",
      },
    ],
  },
  {
    id: "satellite",
    name: "Weather satellite images",
    band: "137 MHz antenna example",
    frequencyHz: 137e6,
    range: [137e6, 138e6],
    shape: "v-dipole",
    result:
      "Capture a compatible weather-satellite downlink during a visible pass, then decode the I/Q recording externally.",
    start:
      "A horizontal V-dipole is a simple starting design. A correctly phased and polarized QFH is a more involved alternative.",
    polarization:
      "Circular polarization rotates the electric field. Match the required handedness in a QFH design; a linear V-dipole can still receive a circular signal, with a nominal 3 dB polarization mismatch.",
    placement:
      "Place the V in a horizontal plane with open sky above it. This is different from an upright V or a terrestrial vertical dipole.",
    tips: [
      "The illustrated kit design uses 53.4 cm arms and a 120° opening at 137 MHz. These are design dimensions, not the general calculator output.",
      "Check an active spacecraft, current downlink and a pass for your receiving site before recording.",
      "Start with antenna placement. A filtered LNA is optional; confirm its passband and power arrangement first.",
    ],
    upgrade:
      "A QFH (quadrifilar helix): phased, twisted elements designed for circular polarization and sky coverage. A generic coil is not equivalent. Use a complete design with the correct handedness.",
    capability:
      "Capture in BrowserSDR → decode externally, for example with SatDump. Native Meteor LRPT images are not implemented. NOAA-15/18/19 were retired in 2025; older tutorials describe historical services.",
    sources: [
      kitSource,
      {
        label: "WiMo · QFH construction and coverage",
        url: "https://www.wimo.com/en/antennas/receive-antennas/ke-137",
        date: "Publication date unknown · vendor description",
      },
      {
        label: "NOAA · POES retirement notice",
        url: "https://ospo.noaa.gov/data/messages/2025/08/MSG_20250820_1410.html",
        date: "20 August 2025 · final update",
      },
    ],
  },
];

export function antennaGuideFor(
  mode: ReceiverMode | undefined,
  frequencyHz: number | undefined,
) {
  if (!mode || !frequencyHz) return undefined;
  return ANTENNA_GUIDES.find(
    (guide) =>
      guide.mode === mode &&
      frequencyHz >= guide.range[0] &&
      frequencyHz <= guide.range[1],
  );
}
export function antennaLengths(frequencyHz: number) {
  if (!Number.isFinite(frequencyHz) || frequencyHz < 1 || frequencyHz > 1e12)
    throw new Error("Enter a frequency from 1 Hz to 1000 GHz.");
  const wavelengthM = 299_792_458 / frequencyHz;
  const practicalDipoleM = 142_646_400 / frequencyHz;
  return {
    wavelengthM,
    quarterWaveM: wavelengthM / 4,
    halfWaveM: wavelengthM / 2,
    practicalDipoleM,
    practicalArmM: practicalDipoleM / 2,
  };
}
export type AntennaUnits = "metric" | "imperial";
export function antennaLengthLabel(metres: number, units: AntennaUnits) {
  if (units === "imperial")
    return metres >= 0.3048
      ? `${(metres / 0.3048).toFixed(2)} ft`
      : `${(metres / 0.0254).toFixed(metres / 0.0254 < 0.01 ? 4 : 2)} in`;
  if (metres < 0.01) return `${(metres * 1000).toFixed(2)} mm`;
  return metres >= 1
    ? `${metres.toFixed(2)} m`
    : `${(metres * 100).toFixed(1)} cm`;
}

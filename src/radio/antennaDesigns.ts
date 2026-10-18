import type { AntennaUnits } from "./antennaGuide";

export const ANTENNA_TYPES = [
  ["recommended", "Guide recommendation"],
  ["whip", "Telescopic whip / direct attached"],
  ["telescopic", "Telescopic monopole / magnetic base"],
  ["dipole", "Adjustable two-arm dipole"],
  ["ground-plane", "Vertical ground-plane antenna"],
  ["v-dipole", "Horizontal V-dipole"],
  ["qfh", "Quadrifilar helix (QFH)"],
  ["turnstile", "Turnstile / crossed dipoles"],
  ["discone", "Discone"],
  ["yagi", "Yagi"],
  ["log-periodic", "Log-periodic dipole array"],
] as const;
export type AntennaChoice = (typeof ANTENNA_TYPES)[number][0];
export type SelectedAntenna = Exclude<AntennaChoice, "recommended">;
export const isAntennaChoice = (value: unknown): value is AntennaChoice =>
  ANTENNA_TYPES.some(([id]) => id === value);
export const isWhip = (value: AntennaChoice) =>
  value === "whip" || value === "telescopic";

export interface WhipPreferences {
  preset: string;
  minimum: string;
  maximum: string;
  showEighth: boolean;
  fixedSection: string;
  originPreset: string;
}
export const DEFAULT_WHIP: WhipPreferences = {
  preset: "custom",
  minimum: "",
  maximum: "",
  showEighth: false,
  fixedSection: "0",
  originPreset: "",
};
const unitM = (units: AntennaUnits) => (units === "metric" ? 0.01 : 0.0254);
export function parseWhipLimits(
  minimum: string,
  maximum: string,
  units: AntennaUnits,
): {
  minimumM?: number;
  maximumM?: number;
  error?: string;
} {
  const parse = (text: string) => {
    if (!text.trim()) return undefined;
    if (!/^\d+(?:[.,]\d+)?$/.test(text.trim())) return NaN;
    return Number(text.trim().replace(",", ".")) * unitM(units);
  };
  const minimumM = parse(minimum),
    maximumM = parse(maximum);
  if (
    [minimumM, maximumM].some(
      (v) => v !== undefined && (!Number.isFinite(v) || v <= 0 || v > 1000),
    )
  )
    return {
      error: "Enter positive lengths up to 1,000 m, or leave a limit empty.",
    };
  if (minimumM !== undefined && maximumM !== undefined && minimumM > maximumM)
    return { error: "Minimum length must not exceed maximum length." };
  return { minimumM, maximumM };
}
export function whipFit(
  lengthM: number,
  limits: ReturnType<typeof parseWhipLimits>,
) {
  if (limits.error) return "invalid";
  if (limits.minimumM === undefined && limits.maximumM === undefined)
    return "unknown";
  if (limits.maximumM !== undefined && lengthM > limits.maximumM + 1e-7)
    return "too-long";
  if (limits.minimumM !== undefined && lengthM < limits.minimumM - 1e-7)
    return "too-short";
  return "fits";
}
export function convertWhipLimits(
  prefs: WhipPreferences,
  from: AntennaUnits,
  to: AntennaUnits,
): WhipPreferences {
  if (from === to) return prefs;
  if (prefs.preset === "ant500") {
    return {
      ...prefs,
      minimum: String(Number((0.2 / unitM(to)).toFixed(6))),
      maximum: String(Number((0.88 / unitM(to)).toFixed(6))),
    };
  }
  const convert = (text: string) => {
    const parsed = parseWhipLimits(text, "", from);
    if (parsed.error) return text;
    return parsed.minimumM === undefined
      ? ""
      : String(Number((parsed.minimumM / unitM(to)).toFixed(6)));
  };
  return {
    ...prefs,
    minimum: convert(prefs.minimum),
    maximum: convert(prefs.maximum),
    fixedSection:
      prefs.fixedSection === "0" || !prefs.fixedSection
        ? "0"
        : convert(prefs.fixedSection),
  };
}
export function ant500Preset(units: AntennaUnits): WhipPreferences {
  return convertWhipLimits(
    { ...DEFAULT_WHIP, preset: "ant500", minimum: "20", maximum: "88" },
    "metric",
    units,
  );
}

export const DESIGN_ADVICE: Record<
  SelectedAntenna,
  {
    intro: string;
    orientation: string;
    placement: string;
    measurement: string;
  }
> = {
  whip: {
    intro:
      "A single telescopic radiator connects directly to the receiver. The chassis, cable and nearby objects form part of its return path; it has no magnetic base.",
    orientation:
      "This is a linearly polarized antenna. Start upright for vertical signals; compare orientations for broadcast FM. It is a compromise for circularly polarized satellites.",
    placement:
      "Keep the whip clear of computer displays and USB noise. A short extension cable can help separate the receiver from the computer, but also changes the antenna system.",
    measurement:
      "Measure exposed metal from the radiator's mounting end to the tip. Exclude the connector and receiver. Confirm the actual minimum and maximum; do not force the mechanism.",
  },
  telescopic: {
    intro:
      "A telescopic monopole uses a single metal mast on a magnetic base. The starting length applies to the mast; the base and coax are excluded.",
    orientation:
      "The whip is linearly polarized. Start upright for vertical signals and compare orientations for FM. Length alone does not provide circular polarization.",
    placement:
      "Put the magnetic base on a broad steel surface and try a clear position away from electronics. The ground plane and cable affect the result.",
    measurement:
      "Include fixed exposed metal sections, but exclude the magnetic base and coax. Check the mast can reach the starting length.",
  },
  dipole: {
    intro:
      "Two equal arms meet at a center feed point. Measure each arm separately; the cable is not an arm.",
    orientation:
      "Align the arms with the signal's linear polarization. Try vertical and horizontal orientations for FM; polarization depends on the transmitter.",
    placement:
      "Support both arms clear of metal, walls and noisy electronics. Route the feedline away from the arms; use an appropriate balanced feed or choke.",
    measurement:
      "Adjust both arms equally. Practical and ideal dimensions are starting estimates; feed, element thickness and surroundings change the tuned length.",
  },
  "ground-plane": {
    intro:
      "One vertical radiator works against several conductive radials at the feed point. It is a simple option for vertically polarized terrestrial signals.",
    orientation:
      "Keep the radiator upright. Coverage is around the horizon; the overhead null makes this a compromise for passing satellites.",
    placement:
      "Give the radials space and a clear view toward the signal. Keep coax loss low, especially for 1090 MHz ADS-B.",
    measurement:
      "Start with a quarter-wave radiator and approximately quarter-wave radials. Radial angle, feed and mounting affect impedance; follow a complete design.",
  },
  "v-dipole": {
    intro:
      "A simple horizontal V-shaped dipole for the 137 MHz satellite band. The illustrated 53.4 cm / 120° kit design is a specific reference.",
    orientation:
      "Both arms lie horizontally, with a 120° angle viewed from above. It remains linearly polarized; the V shape does not create circular polarization.",
    placement:
      "Choose an open sky view with the arms clear of obstructions. Satellite reception also depends on the pass and signal availability.",
    measurement:
      "The reference uses two 53.4 cm arms for 137 MHz. Do not apply those dimensions to other bands or use them as QFH loop lengths.",
  },
  qfh: {
    intro:
      "Two twisted, phased loops form a quadrifilar helix. A correctly designed QFH is useful for circularly polarized satellite reception over the sky.",
    orientation:
      "Mount the helix upright and match the signal's circular-polarization handedness. Geometry and feed phasing both matter.",
    placement:
      "Provide a clear sky view. A QFH for one band is not a general replacement for an FM or ADS-B antenna.",
    measurement:
      "Choose a complete design for the target band. Loop lengths, loop sizes, pitch and feed arrangement cannot be obtained from one quarter-wave number.",
  },
  turnstile: {
    intro:
      "Two dipoles cross at right angles. A satellite turnstile uses the correct phase relationship and often a reflector to shape sky coverage.",
    orientation:
      "For circular polarization along the axis, feed the crossed dipoles 90° apart and check handedness. Simply crossing two wires is insufficient.",
    placement:
      "Mount a sky-facing design with an open view. Reflector spacing and the complete antenna design determine useful coverage.",
    measurement:
      "Use a complete band-specific design for arm lengths, phasing line and reflector. Cable velocity factor belongs in the phasing-line calculation.",
  },
  discone: {
    intro:
      "A disc above a cone provides broad frequency coverage without adjusting a telescopic mast for every channel. Useful for general VHF/UHF monitoring.",
    orientation:
      "Mount the cone upright. Typical discones receive vertical polarization around the horizon; they are not circularly polarized sky antennas.",
    placement:
      "A clear, elevated installation and suitable low-loss cable matter. Broad coverage also admits strong unwanted signals that can overload a receiver.",
    measurement:
      "Use the manufacturer's receiving range and assembly dimensions. Disc size, cone size and feed gap form one design; there is no single whip setting.",
  },
  yagi: {
    intro:
      "A driven element, reflector and directors concentrate reception in one direction. Useful for a known transmitter or a tracked target.",
    orientation:
      "Point along the boom toward the target and rotate the elements to match polarization. A basic Yagi is linearly polarized.",
    placement:
      "Allow space around the elements and keep the target in the beam. A moving satellite needs tracking; this is not omnidirectional coverage.",
    measurement:
      "Choose a complete design for the band. Element lengths, spacing, boom and matching must work together; a quarter-wave calculator cannot design the array.",
  },
  "log-periodic": {
    intro:
      "A sequence of differently sized dipoles provides directional coverage over a designed frequency range. Useful when aiming at signals across several bands.",
    orientation:
      "For a conventional LPDA, aim toward the short-element end and rotate the elements to match linear polarization. Follow the antenna's direction markings.",
    placement:
      "Keep the forward view clear and use suitable feedline. It still needs aiming and does not cover every frequency merely because it has many elements.",
    measurement:
      "Use the specified design range. Element scaling, spacing and alternating feed connections are essential; do not set every element to the same length.",
  },
};

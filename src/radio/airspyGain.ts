import { validateAirspySettings, type AirspySettings } from "./airspySettings";

// BSD-licensed libairspy gain schedules, fc61ab6be57ed61f0e2bdd9c6dfae74cacef57d0.
// Listed in ascending user gain order (the host library reverses its arrays).
const linearity = {
  vga: [
    4, 5, 6, 7, 8, 9, 10, 10, 10, 10, 10, 10, 10, 10, 10, 11, 11, 11, 11, 11,
    12, 13,
  ],
  mixer: [0, 0, 1, 1, 1, 1, 2, 2, 0, 0, 1, 0, 0, 5, 6, 6, 7, 8, 9, 11, 12, 12],
  lna: [0, 0, 0, 0, 0, 0, 0, 1, 3, 5, 6, 8, 9, 8, 9, 9, 10, 12, 13, 14, 14, 14],
};
const sensitivity = {
  vga: [4, 4, 4, 4, 4, 4, 4, 4, 4, 5, 5, 5, 5, 5, 6, 7, 8, 9, 10, 11, 12, 13],
  mixer: [
    0, 0, 0, 0, 1, 2, 2, 3, 4, 4, 4, 7, 8, 9, 9, 10, 10, 11, 12, 12, 12, 12,
  ],
  lna: [
    0, 1, 2, 3, 5, 6, 7, 8, 9, 9, 12, 12, 13, 14, 14, 14, 14, 14, 14, 14, 14,
    14,
  ],
};
export function airspyGainStages(value: AirspySettings) {
  const s = validateAirspySettings(value);
  if (s.gainMode === "manual")
    return {
      lna: s.lna,
      mixer: s.mixer,
      vga: s.vga,
      lnaAgc: s.lnaAgc,
      mixerAgc: s.mixerAgc,
    };
  const table = s.gainMode === "linearity" ? linearity : sensitivity;
  return {
    lna: table.lna[s.gain]!,
    mixer: table.mixer[s.gain]!,
    vga: table.vga[s.gain]!,
    lnaAgc: false,
    mixerAgc: false,
  };
}

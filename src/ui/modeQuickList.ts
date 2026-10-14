import type { ReceiverMode } from "../radio/receiverConfig";
import { MODE_DESCRIPTIONS } from "./modeCatalog";

export const QUICK_MODES_KEY = "browsersdr.quickModes.v1";
export const QUICK_MODE_LIMIT = 7;
export const DEFAULT_QUICK_MODES: readonly ReceiverMode[] = [
  "WBFM",
  "NBFM",
  "AM",
  "USB",
  "LSB",
  "CW",
  "OFF",
];

export function readQuickModes(
  storage: Pick<Storage, "getItem">,
): ReceiverMode[] {
  try {
    const raw = storage.getItem(QUICK_MODES_KEY);
    if (raw === null) return [...DEFAULT_QUICK_MODES];
    const value: unknown = JSON.parse(raw);
    if (
      !Array.isArray(value) ||
      value.length > QUICK_MODE_LIMIT ||
      value.some(
        (mode) =>
          typeof mode !== "string" || !Object.hasOwn(MODE_DESCRIPTIONS, mode),
      ) ||
      new Set(value).size !== value.length
    )
      return [...DEFAULT_QUICK_MODES];
    return value as ReceiverMode[];
  } catch {
    return [...DEFAULT_QUICK_MODES];
  }
}

export function quickModesWithCurrent(
  pins: readonly ReceiverMode[],
  current: ReceiverMode,
): ReceiverMode[] {
  return pins.includes(current) ? [...pins] : [current, ...pins];
}

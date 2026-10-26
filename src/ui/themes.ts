import { useSyncExternalStore } from "react";

export const THEME_KEY = "browsersdr.theme.v1";
export const THEMES = [
  { id: "classic", name: "Midnight Observatory" },
  { id: "field-deck", name: "Amber Field Deck" },
  { id: "vice-afterglow", name: "Vice Afterglow" },
  { id: "graphite-studio", name: "Graphite Studio" },
] as const;
export type ThemeId = (typeof THEMES)[number]["id"];

export function parseTheme(value: unknown): ThemeId {
  return THEMES.some((theme) => theme.id === value) ? value as ThemeId : "classic";
}
export function readTheme(storage: Pick<Storage, "getItem">): ThemeId {
  try { return parseTheme(storage.getItem(THEME_KEY)); }
  catch { return "classic"; }
}
let current: ThemeId = "classic";
const listeners = new Set<() => void>();
function applyTheme(theme: ThemeId) {
  current = theme;
  document.documentElement.dataset.theme = theme;
  for (const listener of listeners) listener();
}
export function setTheme(theme: ThemeId) {
  applyTheme(parseTheme(theme));
  try { localStorage.setItem(THEME_KEY, current); }
  catch { /* Appearance remains usable when optional storage is unavailable. */ }
}
function onStorage(event: StorageEvent) {
  if (event.key === THEME_KEY || event.key === null) {
    try { if (event.storageArea !== localStorage) return; }
    catch { return; }
    applyTheme(parseTheme(event.key === null ? null : event.newValue));
  }
}
/** Apply the saved appearance before mounting React; no receiver state is touched. */
export function initializeTheme() {
  try { applyTheme(readTheme(localStorage)); }
  catch { applyTheme("classic"); }
  window.addEventListener("storage", onStorage);
}
function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}
export function useTheme(): ThemeId {
  return useSyncExternalStore(subscribe, () => current, () => "classic");
}

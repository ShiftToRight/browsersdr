import { validateBookmark, type Bookmark } from "./bookmarks";
import type { ReceiverModeSettings } from "./receiverConfig";

export const SETTINGS_SHARE_SCHEMA = "browsersdr-settings-v1";
export const MAX_SETTINGS_SHARE_LENGTH = 8192;
export interface SharedDisplay {
  compact: boolean;
  floorDb: number;
  rangeDb: number;
}
export interface SharedSettings {
  schema: typeof SETTINGS_SHARE_SCHEMA;
  frequencyHz: number;
  settings: ReceiverModeSettings;
  display: SharedDisplay;
}
const ephemeralId = "00000000-0000-4000-8000-000000000000";

/** Reuse the portable favorite validator without including personal collection metadata. */
export function sharedSettingsBookmark(
  value: Pick<SharedSettings, "frequencyHz" | "settings">,
): Bookmark {
  return validateBookmark({
    id: ephemeralId,
    name: "Shared settings",
    frequencyHz: value.frequencyHz,
    settings: value.settings,
    tags: [],
    notes: "",
  });
}
export function validateSharedSettings(value: unknown): SharedSettings {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Invalid settings link.");
  const row = value as Record<string, unknown>;
  if (row.schema !== SETTINGS_SHARE_SCHEMA)
    throw new Error("Unsupported settings link version.");
  const bookmark = sharedSettingsBookmark(row as unknown as SharedSettings);
  const display = row.display as SharedDisplay | undefined;
  if (
    !display ||
    typeof display.compact !== "boolean" ||
    !Number.isFinite(display.floorDb) ||
    display.floorDb < -120 ||
    display.floorDb > -30 ||
    !Number.isFinite(display.rangeDb) ||
    display.rangeDb < 20 ||
    display.rangeDb > 120
  )
    throw new Error("Invalid spectrum display settings in link.");
  return {
    schema: SETTINGS_SHARE_SCHEMA,
    frequencyHz: bookmark.frequencyHz,
    settings: bookmark.settings,
    display: {
      compact: display.compact,
      floorDb: display.floorDb,
      rangeDb: display.rangeDb,
    },
  };
}
export function hasSettingsShare(hash: string): boolean {
  return new URLSearchParams(hash.replace(/^#/, "")).has("settings");
}
export function readSettingsShare(hash: string): {
  settings?: SharedSettings;
  error?: string;
} {
  if (!hasSettingsShare(hash)) return {};
  try {
    if (hash.length > MAX_SETTINGS_SHARE_LENGTH)
      throw new Error("Settings link is too large.");
    const params = new URLSearchParams(hash.replace(/^#/, ""));
    const encoded = params.get("settings")!;
    if (
      params.getAll("settings").length !== 1 ||
      !/^[A-Za-z0-9_-]+$/.test(encoded)
    )
      throw new Error("Invalid settings link encoding.");
    const bytes = Uint8Array.from(
      atob(encoded.replaceAll("-", "+").replaceAll("_", "/")),
      (char) => char.charCodeAt(0),
    );
    return {
      settings: validateSharedSettings(
        JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)),
      ),
    };
  } catch (error) {
    return {
      error: error instanceof Error ? error.message : "Invalid settings link.",
    };
  }
}
export function createSettingsShareUrl(
  baseUrl: string,
  value: SharedSettings,
): string {
  const settings = validateSharedSettings(value);
  const encoded = btoa(
    String.fromCharCode(...new TextEncoder().encode(JSON.stringify(settings))),
  )
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
  const url = new URL(baseUrl);
  // Do not forward Atlas candidate queries, experimental flags, credentials or prior hashes.
  url.username = "";
  url.password = "";
  url.search = "";
  url.hash = `settings=${encoded}`;
  if (url.hash.length > MAX_SETTINGS_SHARE_LENGTH)
    throw new Error("Settings link is too large.");
  if (!["http:", "https:"].includes(url.protocol))
    throw new Error("Settings links require an HTTP or HTTPS address.");
  return url.href;
}

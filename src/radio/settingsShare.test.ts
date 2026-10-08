import { expect, it } from "vitest";
import { defaultModeSettings, RECEIVER_MODES } from "./receiverConfig";
import {
  createSettingsShareUrl,
  hasSettingsShare,
  MAX_SETTINGS_SHARE_LENGTH,
  readSettingsShare,
  SETTINGS_SHARE_SCHEMA,
  validateSharedSettings,
  type SharedSettings,
} from "./settingsShare";

const preset = (): SharedSettings => ({
  schema: SETTINGS_SHARE_SCHEMA,
  frequencyHz: 99_700_001,
  settings: defaultModeSettings("CW"),
  display: { compact: true, floorDb: -99, rangeDb: 73 },
});
const hash = (value: unknown) =>
  `#settings=${Buffer.from(JSON.stringify(value)).toString("base64url")}`;

it("round trips every supported mode including full CW and SRD settings without shared object ownership", () => {
  for (const mode of RECEIVER_MODES) {
    const value = { ...preset(), settings: defaultModeSettings(mode) };
    if (value.settings.beatToneHz) value.settings.beatToneHz = 875;
    if (value.settings.srd) {
      value.settings.srd.threshold.mode = "manual";
      value.settings.srd.threshold.carrierLevel = 0.35;
      value.settings.srd.bitSlice.polarity = "inverted";
    }
    const result = readSettingsShare(
      new URL(createSettingsShareUrl("https://radio.example/receiver/", value))
        .hash,
    );
    expect(result.settings).toEqual(value);
    expect(result.settings?.settings).not.toBe(value.settings);
    expect(result.settings?.settings.srd).not.toBe(value.settings.srd ?? null);
  }
});
it("copies only portable fields, drops queries/hash/auth and preserves the deployment path", () => {
  const input = {
    ...preset(),
    token: "secret",
    source: "hackrf",
    notes: "private",
    settings: { ...preset().settings, token: "secret" },
    display: { ...preset().display, usbSerial: "serial" },
  };
  const url = new URL(
    createSettingsShareUrl(
      "https://user:password@radio.example/subpath/?station_id=old&token=secret#old",
      input,
    ),
  );
  expect(url.pathname).toBe("/subpath/");
  expect(url.search + url.username + url.password).toBe("");
  const decoded = readSettingsShare(url.hash).settings!;
  expect(decoded).toEqual(preset());
  expect(JSON.stringify(decoded)).not.toMatch(
    /secret|private|serial|source|station/,
  );
});
it("rejects unsupported versions, invalid frequency, decoder settings and display ranges", () => {
  for (const value of [
    null,
    [],
    { ...preset(), schema: "browsersdr-settings-v2" },
    ...[0, 6e9 + 1, 99.5, "100000000"].map((frequencyHz) => ({
      ...preset(),
      frequencyHz,
    })),
    { ...preset(), settings: { ...preset().settings, mode: "UNKNOWN" } },
    { ...preset(), settings: { ...preset().settings, beatToneHz: 2000 } },
    { ...preset(), settings: { ...defaultModeSettings("SRD"), srd: {} } },
    ...[{ compact: "true" }, { floorDb: -121 }, { rangeDb: 121 }].map(
      (display) => ({
        ...preset(),
        display: { ...preset().display, ...display },
      }),
    ),
  ]) {
    expect(() => validateSharedSettings(value)).toThrow();
    expect(readSettingsShare(hash(value)).error).toBeTruthy();
  }
});
it("bounds parsing and rejects corrupt/duplicate encodings without consuming unrelated fragments", () => {
  expect(hasSettingsShare("#unrelated=1")).toBe(false);
  expect(readSettingsShare("#unrelated=1")).toEqual({});
  for (const fragment of [
    "#settings=",
    "#settings=%%%",
    "#settings=ey",
    "#settings=_w",
    `${hash(preset())}&settings=other`,
    `#settings=${"a".repeat(MAX_SETTINGS_SHARE_LENGTH)}`,
  ])
    expect(readSettingsShare(fragment).error).toBeTruthy();
  expect(() =>
    createSettingsShareUrl("file:///tmp/index.html", preset()),
  ).toThrow();
});

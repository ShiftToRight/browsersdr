import { expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { RTL2832U } from "@jtarrio/webrtlsdr/rtlsdr/rtl2832u.js";
import { sourceCapabilities, validateSourceConfiguration } from "./sourceCapabilities";
import { RECEIVER_MODES, defaultModeSettings } from "./receiverConfig";
import { loadSourcePreferences, saveSourcePreferences } from "./sourcePreferences";
import { validateLiveRateBudget } from "./liveRateBudget";
import { RTL_EXPERIMENTAL_SAMPLE_RATE_HZ, validateRtlAcceptedRate } from "./rtlSampleRate";

it("programs the literal 3.2 MS/s register vector through the pinned WebRTLSDR 3.0.6 driver", async () => {
  const driver = Object.assign(Object.create(RTL2832U.prototype), { ppm: 0, com: { setDemodReg: vi.fn(async () => undefined) } });
  expect(await driver.setSampleRate(3_200_000)).toBe(3_200_000);
  expect(driver.com.setDemodReg.mock.calls).toEqual([[1, 0x9f, 0x240, 2], [1, 0xa1, 0, 2], [1, 1, 0x14, 1], [1, 1, 0x10, 1]]);
  driver.com.setDemodReg.mockRejectedValueOnce(new Error("Control transfer failed"));
  await expect(driver.setSampleRate(3_200_000)).rejects.toThrow("Control transfer failed");
  // Source hash pins the inspected library body, not firmware or physical reception.
  expect(createHash("sha256").update(readFileSync(new URL("../../node_modules/@jtarrio/webrtlsdr/dist/rtlsdr/rtl2832u.js", import.meta.url))).digest("hex")).toBe("2dcf17c50633bf4543d4ea8c27a21153a6a6ead9d018d9c8ff4577cfbc6dcb61");
});

it("exposes 3.2 only for RTL hardware and preserves defaults and explicit saved choices", () => {
  expect(sourceCapabilities("rtl-sdr").rates).toEqual({ kind: "choices", valuesHz: [1_024_000, 2_400_000, 3_200_000], defaultHz: 1_024_000, experimentalHz: [3_200_000] });
  for (const source of ["hackrf", "bladerf", "usrp-b205", "synthetic"] as const) {
    const caps = sourceCapabilities(source);
    expect(caps.rates.kind === "choices" && caps.rates.valuesHz.includes(3_200_000)).toBe(false);
    expect(() => validateSourceConfiguration({ source, channelFrequencyHz: 100e6, sampleRateHz: 3_200_000 })).toThrow();
  }
  const storage = new Map<string, string>();
  const access = { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => { storage.set(key, value); } };
  expect(loadSourcePreferences(access, "rtl-sdr").sampleRateHz).toBe(1_024_000);
  for (const rate of [2_400_000, 3_200_000]) {
    saveSourcePreferences(access, "rtl-sdr", { frequencyHz: 100e6, sampleRateHz: rate, modeSettings: defaultModeSettings("RTTY") });
    expect(loadSourcePreferences(access, "rtl-sdr").sampleRateHz).toBe(rate);
  }
  for (const mode of RECEIVER_MODES)
    expect(() => validateSourceConfiguration({ source: "rtl-sdr", channelFrequencyHz: 100e6, sampleRateHz: RTL_EXPERIMENTAL_SAMPLE_RATE_HZ, modeSettings: defaultModeSettings(mode) }), mode).not.toThrow();
});

it("rejects a mismatched experimental readback without rounding and fits installed audio budgets", () => {
  for (const rate of [3_200_001, 3_199_999, NaN, Infinity, 0]) expect(() => validateRtlAcceptedRate(3_200_000, rate)).toThrow(/exact experimental/);
  for (const audio of [44_100, 48_000, 96_000, 192_000]) expect(() => validateLiveRateBudget(3_200_000, audio)).not.toThrow();
});

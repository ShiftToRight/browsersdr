// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { operatingSystem, usbAvailability } from "./browserEnvironment";

afterEach(() => vi.unstubAllGlobals());

describe("coarse browser platform", () => {
  const browser = (userAgent: string, platform = "", maxTouchPoints = 0) => ({
    userAgent,
    platform,
    maxTouchPoints,
  });
  it("prefers Client Hints without requesting detailed system information", () => {
    expect(
      operatingSystem({
        ...browser("Linux"),
        userAgentData: { platform: "Windows" },
      }),
    ).toBe("Windows");
  });
  it.each([
    ["Mozilla/5.0 (X11; Linux x86_64)", "Linux"],
    ["Mozilla/5.0 (X11; CrOS x86_64)", "ChromeOS"],
    ["Mozilla/5.0 (Linux; Android 15)", "Android"],
    ["Mozilla/5.0 (Windows NT 10.0)", "Windows"],
    ["Mozilla/5.0 (Macintosh; Intel Mac OS X)", "macOS"],
    ["Mozilla/5.0 (iPhone; CPU iPhone OS)", "iOS"],
    ["privacy browser", "Unknown"],
  ])("falls back to %s", (ua, expected) => {
    expect(operatingSystem(browser(ua))).toBe(expected);
  });
  it("recognizes iPad desktop mode and ignores unrecognized Client Hints", () => {
    expect(operatingSystem(browser("Mac OS X", "MacIntel", 5))).toBe("iOS");
    expect(
      operatingSystem({
        ...browser("CrOS"),
        userAgentData: { platform: "Other" },
      }),
    ).toBe("ChromeOS");
    vi.stubGlobal("navigator", undefined);
    expect(operatingSystem()).toBe("Unknown");
  });
  it("checks actual browser capabilities independently of the OS", () => {
    vi.stubGlobal("isSecureContext", false);
    vi.stubGlobal("navigator", { usb: { requestDevice() {} } });
    expect(usbAvailability()).toBe("insecure");
    vi.stubGlobal("isSecureContext", true);
    expect(usbAvailability()).toBe("available");
    vi.stubGlobal("navigator", {});
    expect(usbAvailability()).toBe("unsupported");
  });
});

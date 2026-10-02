export const OPERATING_SYSTEMS = [
  "Linux",
  "Windows",
  "macOS",
  "ChromeOS",
  "Android",
  "iOS",
  "Unknown",
] as const;

export type OperatingSystem = (typeof OPERATING_SYSTEMS)[number];

type BrowserNavigator = Pick<
  Navigator,
  "userAgent" | "platform" | "maxTouchPoints"
> & {
  userAgentData?: { platform?: string };
};

/** Coarse platform information only; no high-entropy Client Hints are requested. */
export function operatingSystem(
  browser: BrowserNavigator | undefined = typeof navigator === "undefined"
    ? undefined
    : navigator,
): OperatingSystem {
  if (!browser) return "Unknown";
  const hint = browser.userAgentData?.platform;
  if (
    hint &&
    OPERATING_SYSTEMS.some((value) => value === hint && value !== "Unknown")
  )
    return hint as OperatingSystem;
  const ua = browser.userAgent;
  // Android and ChromeOS often also identify themselves as Linux.
  if (/Android/i.test(ua)) return "Android";
  if (/CrOS/i.test(ua)) return "ChromeOS";
  if (
    /iPhone|iPad|iPod/i.test(ua) ||
    (/Mac/i.test(browser.platform) && browser.maxTouchPoints > 1)
  )
    return "iOS";
  if (/Windows/i.test(ua)) return "Windows";
  if (/Mac OS/i.test(ua)) return "macOS";
  if (/Linux/i.test(ua)) return "Linux";
  return "Unknown";
}

export function browserSummary(): string {
  const ua = navigator.userAgent;
  for (const [name, expression] of [
    ["Edge", /Edg\/(\d+)/],
    ["Chrome", /Chrome\/(\d+)/],
    ["Firefox", /Firefox\/(\d+)/],
    ["Safari", /Version\/(\d+).*Safari/],
  ] as const) {
    const match = ua.match(expression);
    if (match) return `${name} ${match[1]}`;
  }
  return "Unknown browser";
}

export type UsbAvailability = "available" | "insecure" | "unsupported";

export function usbAvailability(): UsbAvailability {
  if (!window.isSecureContext) return "insecure";
  return typeof navigator.usb?.requestDevice === "function"
    ? "available"
    : "unsupported";
}

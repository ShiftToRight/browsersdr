import type { OperatingSystem } from "../platform/browserEnvironment";
import type { ReceiverLifecycle, SourceKind } from "./types";

export type ReceiverIssueCode =
  | "selection-cancelled"
  | "browser-unsupported"
  | "device-unsupported"
  | "usb-permission"
  | "usb-busy"
  | "usb-transfer"
  | "power-cycle"
  | "firmware"
  | "audio-blocked"
  | "settings"
  | "unknown";

export interface ReceiverIssue {
  code: ReceiverIssueCode;
  summary: string;
  source: SourceKind;
  operation?: ReceiverLifecycle;
}

export interface RecoveryStep {
  text: string;
  command?: string;
  note?: string;
  link?: { label: string; url: string };
}

const USB_SETUP =
  "https://developer.chrome.com/docs/capabilities/build-for-webusb#platform-specific_considerations";
const RTL_SETUP = "https://www.rtl-sdr.com/rtl-sdr-quick-start-guide/";

export function isUsbSource(source: SourceKind): boolean {
  return source !== "synthetic" && source !== "replay";
}

/** Preserve the failed operation and inspect wrapped WebUSB errors before translating. */
export function classifyReceiverIssue(
  error: unknown,
  source: SourceKind = "rtl-sdr",
  operation?: ReceiverLifecycle,
): ReceiverIssue {
  const messages: string[] = [];
  const names: string[] = [];
  let cause = error;
  for (let depth = 0; depth < 4 && cause !== undefined; depth++) {
    if (
      cause &&
      typeof cause === "object" &&
      "message" in cause &&
      typeof cause.message === "string"
    ) {
      messages.push(cause.message);
      names.push(
        "name" in cause && typeof cause.name === "string"
          ? cause.name
          : "Error",
      );
      cause = "cause" in cause ? cause.cause : undefined;
    } else {
      messages.push(String(cause));
      break;
    }
  }
  const message = messages.join(" ");
  const name = names.join(" ");
  const opening =
    !operation || ["requesting-permission", "connecting"].includes(operation);
  const issue = (code: ReceiverIssueCode, summary: string): ReceiverIssue => ({
    code,
    summary,
    source,
    operation,
  });
  if (/BrowserSdrTabBusy/.test(name))
    return issue("usb-busy", "This receiver is connected in another BrowserSDR tab or window. Disconnect it there, then retry here.");
  // RTL wraps rejected chooser requests as NoDeviceSelected, including denials.
  // Preserve the underlying permission failure so it remains actionable.
  if (
    /NoDeviceSelected/.test(name) &&
    /SecurityError|NotAllowedError/.test(name)
  )
    return issue("usb-permission", "USB access was denied.");
  if (
    /NoDeviceSelected/.test(name) ||
    (opening &&
      names[0] === "NotFoundError" &&
      !/removed|disconnected|gone/i.test(message))
  )
    return issue(
      "selection-cancelled",
      "Device selection was cancelled. Nothing was connected.",
    );
  if (
    /NoUsbSupport/.test(name) ||
    /WebUSB.*(?:unavailable|not supported)|does not support.*WebUSB/i.test(
      message,
    )
  )
    return issue(
      "browser-unsupported",
      "USB access is unavailable in this browser.",
    );
  if (/power.?cycle|unplug.*replug/i.test(message))
    return issue(
      "power-cycle",
      messages[0] || "The device needs a power cycle.",
    );
  if (/UnsupportedDevice/.test(name) || /unsupported tuner/i.test(message))
    return issue(
      "device-unsupported",
      source === "rtl-sdr"
        ? "The selected device uses an unsupported tuner. Use an RTL2832U with an R820/R828/R860 tuner."
        : "The selected device is not supported by this receiver profile.",
    );
  // An audio permission failure must not be confused with USB permission denial.
  if (
    /AudioContext|autoplay|audio.*(?:start|resume|permission|blocked|suspend|denied)/i.test(
      message,
    ) &&
    !/USB access denied/i.test(message)
  )
    return issue("audio-blocked", "Audio could not start.");
  if (
    isUsbSource(source) &&
    (/SecurityError/.test(name) ||
      /access denied|permission denied|USB access denied/i.test(message) ||
      (opening && /NotAllowedError/.test(name)))
  )
    return issue("usb-permission", "USB access was denied.");
  if (
    /claim\s*interface|claimInterface|another application|already.*(?:claimed|owner)|device.*busy/i.test(
      message,
    )
  )
    return issue(
      "usb-busy",
      "The device could not be opened. Another application or a system driver may be using it.",
    );
  if (
    /firmware|FPGA|checksum|image.*(?:missing|mismatch|incompatible)|unsupported.*(?:profile|revision)/i.test(
      message,
    )
  )
    return issue(
      "firmware",
      messages[0] || "The device setup files could not be verified.",
    );
  if (
    isUsbSource(source) &&
    (/UsbTransferError|NetworkError/.test(name) ||
      /unplug|transfer|device.*(?:gone|removed|disconnected)/i.test(message))
  )
    return issue("usb-transfer", "The sample transfer stopped.");
  if (/NotAllowedError/.test(name) && operation === "starting")
    return issue("audio-blocked", "Audio could not start.");
  if (
    /frequency|bandwidth|gain|sample rate|squelch|PLL not locked|receiver is busy applying/i.test(
      message,
    )
  )
    return issue(
      "settings",
      messages[0] || "The receiver settings could not be applied.",
    );
  return issue("unknown", `Receiver failed: ${messages[0] || "Unknown error"}`);
}

export function deviceSetupSteps(
  source: SourceKind,
  os: OperatingSystem,
  permissionsOnly = false,
): RecoveryStep[] {
  if (!isUsbSource(source)) return [];
  const steps: RecoveryStep[] = [
    { text: "Close other SDR apps and browser tabs using this device." },
  ];
  if (os === "Linux") {
    if (source === "rtl-sdr" && !permissionsOnly)
      steps.push(
        {
          text: "The DVB TV driver may claim an RTL-SDR. Check whether it is loaded:",
          command: "lsmod | grep dvb_usb_rtl28xxu",
          note: "If it appears, close TV apps and temporarily unload it with the command below. This interrupts DVB TV use for devices using this module.",
        },
        {
          text: "Temporarily unload the RTL-SDR TV driver, then retry the connection:",
          command: "sudo modprobe -r dvb_usb_rtl28xxu",
          note: "Do not force removal if the module is in use. Restore TV support with sudo modprobe dvb_usb_rtl28xxu. Replugging may load it again; permanent blacklisting is covered in the setup guide.",
          link: { label: "RTL-SDR Linux setup", url: RTL_SETUP },
        },
      );
    steps.push({
      text: "Ensure your user has USB access through a udev rule for this device. After changing the rule, unplug and reconnect the device.",
      note: "BrowserSDR cannot inspect kernel drivers or USB permissions.",
      link: { label: "Linux USB permissions", url: USB_SETUP },
    });
  } else if (os === "Windows")
    steps.push({
      text: "Check that this device’s USB interface uses WinUSB. If it does not, follow the setup guide for your device before replacing its driver.",
      link: {
        label:
          source === "rtl-sdr" ? "RTL-SDR Windows setup" : "Windows USB setup",
        url: source === "rtl-sdr" ? RTL_SETUP : USB_SETUP,
      },
    });
  else if (os === "macOS")
    steps.push({
      text: "A system driver or another app may own the interface. Close the app, then reconnect the device.",
      link: { label: "macOS USB setup", url: USB_SETUP },
    });
  else if (os === "ChromeOS")
    steps.push({
      text: "Release the device from any Linux or Android app using it, then retry in the browser.",
    });
  else if (os === "Android" || os === "iOS")
    steps.push({
      text: "Use a desktop browser with WebUSB support for the supported receiver workflow.",
    });
  else
    steps.push({
      text: "Choose your operating system above for device setup instructions.",
    });
  return steps;
}

export function recoveryHint(
  issue: ReceiverIssue,
  cleanupRequired: boolean,
): string {
  if (cleanupRequired)
    return "Release the device before trying another connection.";
  switch (issue.code) {
    case "selection-cancelled":
      return "Choose your device when you’re ready.";
    case "browser-unsupported":
      return "Open BrowserSDR over HTTPS or localhost in a desktop browser with WebUSB support.";
    case "usb-busy":
      return "Close other SDR apps and tabs, then retry. If it persists, check the setup steps below.";
    case "usb-permission":
      return "Allow USB access for this site, then check the setup steps for your operating system.";
    case "usb-transfer":
      return "Unplug and reconnect the device, then retry the connection.";
    case "power-cycle":
      return "Remove USB and any external power, reconnect the device, then retry.";
    case "audio-blocked":
      return "Start receiving again and allow this page to play audio.";
    case "firmware":
      return "Check the setup files for your device, then retry the connection.";
    case "device-unsupported":
      return "Choose a supported device for the selected source.";
    case "settings":
      return "Review the receiver settings and try again.";
    case "unknown":
      return isUsbSource(issue.source)
        ? "Retry the connection. If it still fails, review the recovery steps or send a report."
        : "Review the source settings, then try again.";
  }
}

export function recoverySteps(
  issue: ReceiverIssue,
  os: OperatingSystem,
  cleanupRequired: boolean,
): RecoveryStep[] {
  const steps: RecoveryStep[] = [];
  if (cleanupRequired)
    steps.push({
      text: "Select Release device and wait for BrowserSDR to finish disconnecting. If release keeps failing, unplug the device and try releasing it again.",
    });
  const powerCycle: RecoveryStep = {
    text: "If the device remains unresponsive, remove its USB connection and any external power. Reconnect it once fully powered off, then select Retry connection.",
    note: "Reconnect only restores the connection; start reception when you’re ready.",
  };
  switch (issue.code) {
    case "usb-busy":
    case "usb-permission":
      if (issue.code === "usb-permission")
        steps.push({
          text: "Allow USB access for BrowserSDR in your browser’s site settings, then choose the device again.",
        });
      steps.push(
        ...deviceSetupSteps(issue.source, os, issue.code === "usb-permission"),
      );
      break;
    case "usb-transfer":
      steps.push({
        text: "Unplug and reconnect the device. Check the cable and try a direct USB port instead of a hub.",
      });
      if (issue.source === "usrp-b205")
        steps.push({ text: "Use a USB 3 port and cable for the B205-mini." });
      steps.push(powerCycle);
      break;
    case "power-cycle":
      steps.push(powerCycle);
      break;
    case "browser-unsupported":
      steps.push({
        text: "Use HTTPS or localhost in a desktop browser with WebUSB support, such as Chrome or Edge. Browser policies can also restrict USB access.",
      });
      break;
    case "firmware":
      steps.push({
        text:
          issue.source === "usrp-b205"
            ? "Import both verified official firmware and FPGA files in Signal source."
            : issue.source === "bladerf"
              ? "Import the official FPGA image matching the detected model and firmware in Signal source."
              : "Check that the device firmware matches the supported receiver profile.",
      });
      if (isUsbSource(issue.source)) steps.push(powerCycle);
      break;
    case "audio-blocked":
      steps.push({
        text: "Allow sound for this site in the browser. Start receiving with a click so the browser can resume audio.",
      });
      break;
    case "device-unsupported":
      steps.push({
        text: "Select the correct source and choose a device supported by that receiver profile.",
      });
      break;
    case "settings":
      steps.push({
        text: "Check the frequency, sample rate and gain supported by the selected device. Apply the corrected settings again.",
      });
      break;
    case "unknown":
      steps.push({
        text: "Check the source settings and retry. If the failure repeats, use Review & send report to share diagnostics.",
      });
      if (isUsbSource(issue.source)) steps.push(powerCycle);
      break;
    case "selection-cancelled":
      break;
  }
  return steps;
}

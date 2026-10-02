import { describe, expect, it } from "vitest";
import {
  classifyReceiverIssue,
  deviceSetupSteps,
  recoveryHint,
  recoverySteps,
} from "./receiverRecovery";
import { OPERATING_SYSTEMS } from "../platform/browserEnvironment";

describe("receiver recovery classification", () => {
  it("distinguishes wrapped claim failures from USB bulk transfer failures", () => {
    const claim = Object.assign(
      new Error("Could not connect. Are you using it in another application?", {
        cause: new DOMException("Unable to claim interface", "NetworkError"),
      }),
      { name: "RadioError.UsbTransferError" },
    );
    expect(classifyReceiverIssue(claim, "rtl-sdr", "connecting").code).toBe(
      "usb-busy",
    );
    expect(
      classifyReceiverIssue(
        new DOMException("transferIn failed", "NetworkError"),
        "hackrf",
        "running",
      ).code,
    ).toBe("usb-transfer");
  });
  it("distinguishes browser USB permission from audio permission", () => {
    expect(
      classifyReceiverIssue(
        new DOMException("Permission denied", "NotAllowedError"),
        "rtl-sdr",
        "requesting-permission",
      ).code,
    ).toBe("usb-permission");
    expect(
      classifyReceiverIssue(
        new DOMException("AudioContext resume blocked", "NotAllowedError"),
        "hackrf",
        "starting",
      ).code,
    ).toBe("audio-blocked");
    expect(
      classifyReceiverIssue(
        new Error("HackRF USB access denied", {
          cause: new DOMException("Denied", "SecurityError"),
        }),
        "hackrf",
        "requesting-permission",
      ).code,
    ).toBe("usb-permission");
  });
  it("keeps RTL chooser permission denial actionable when wrapped as cancellation", () => {
    const error = Object.assign(
      new Error("No device was selected", {
        cause: new DOMException("Access denied", "SecurityError"),
      }),
      { name: "RadioError.NoDeviceSelected" },
    );
    const issue = classifyReceiverIssue(
      error,
      "rtl-sdr",
      "requesting-permission",
    );
    expect(issue.code).toBe("usb-permission");
    expect(
      recoverySteps(issue, "Linux", false).some((step) =>
        step.text.includes("udev"),
      ),
    ).toBe(true);
    expect(
      recoverySteps(issue, "Linux", false).some((step) => step.command),
    ).toBe(false);
    expect(recoverySteps(issue, "Linux", true)[0]?.text).toMatch(
      /^Select Release device/,
    );
  });
  it("treats chooser cancellation as expected without hiding a runtime NotFoundError", () => {
    expect(
      classifyReceiverIssue(
        new DOMException("No device selected", "NotFoundError"),
        "rtl-sdr",
        "requesting-permission",
      ).code,
    ).toBe("selection-cancelled");
    expect(
      classifyReceiverIssue(
        new DOMException("Device disconnected", "NotFoundError"),
        "rtl-sdr",
        "running",
      ).code,
    ).toBe("usb-transfer");
  });
  it("preserves firmware failures and avoids audio hints for an invalid mode", () => {
    expect(
      classifyReceiverIssue(
        new Error("FPGA image checksum does not match"),
        "bladerf",
        "connecting",
      ).code,
    ).toBe("firmware");
    expect(
      classifyReceiverIssue(
        new Error("OFF does not use the analog audio path"),
        "hackrf",
        "running",
      ).code,
    ).not.toBe("audio-blocked");
  });
  it("only shows the DVB module command for Linux RTL-SDR devices", () => {
    const commands = (
      source: Parameters<typeof deviceSetupSteps>[0],
      os: Parameters<typeof deviceSetupSteps>[1],
    ) => deviceSetupSteps(source, os).flatMap((step) => step.command ?? []);
    expect(commands("rtl-sdr", "Linux")).toContain(
      "sudo modprobe -r dvb_usb_rtl28xxu",
    );
    for (const os of OPERATING_SYSTEMS.filter((os) => os !== "Linux"))
      expect(commands("rtl-sdr", os)).toEqual([]);
    for (const source of [
      "hackrf",
      "bladerf",
      "usrp-b205",
      "synthetic",
      "replay",
    ] as const)
      expect(commands(source, "Linux")).toEqual([]);
  });
  it("prioritizes release while cleanup retains the device", () => {
    const issue = classifyReceiverIssue(
      new Error("USB close failed"),
      "hackrf",
      "disconnecting",
    );
    expect(recoveryHint(issue, true)).toMatch(/^Release/);
    expect(recoverySteps(issue, "Linux", true)[0]?.text).toMatch(
      /^Select Release device/,
    );
    expect(
      recoverySteps(issue, "Linux", true).some((step) =>
        step.text.includes("external power"),
      ),
    ).toBe(true);
  });
  it("does not suggest cycling hardware for replay or synthetic failures", () => {
    for (const source of ["synthetic", "replay"] as const) {
      const issue = classifyReceiverIssue(
        new Error("worker failed"),
        source,
        "running",
      );
      expect(
        recoverySteps(issue, "Linux", false).some((step) =>
          /USB|power/.test(step.text),
        ),
      ).toBe(false);
    }
  });
});

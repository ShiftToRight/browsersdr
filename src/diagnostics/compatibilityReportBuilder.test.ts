// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { buildCompatibilityReport } from "./compatibilityReportBuilder";
import type { CompatibilityReportContext } from "./compatibilityTypes";

const context: CompatibilityReportContext = {
  lifecycle: "running",
  source: "hackrf",
  deviceProfile: "HackRF Pro",
  mode: "WBFM",
  sampleRateHz: 9_600_000,
  nativeSampleRateHz: 76_800_000,
  bandwidthHz: 180_000,
  squelch: 0,
  gainMode: "staged",
  gainDb: null,
  lnaGainCode: 16,
  vgaGainDb: 20,
  rfAmplifierEnabled: false,
  antennaPowerEnabled: false,
  firmwareVersion: "v2026.01.3",
  usbApiVersion: 0x110,
  protocolProfile: "hackrf-pro-stable",
  recordingActive: false,
  audioState: "running",
  exactFrequencyHz: 91_400_000,
};

describe("compatibility reports", () => {
  it("captures receiver state while keeping exact frequency opt-in", () => {
    const report = buildCompatibilityReport(context, {
      observations: [{ service: "rds", result: "working" }],
      notes: "  Stable for ten minutes.  ",
    });
    expect(report.reportId).toMatch(/^BC-/);
    expect(report.reportType).toBe("compatibility");
    expect(report.receiver).toMatchObject({
      source: "hackrf",
      sampleRateHz: 9_600_000,
      lnaGainCode: 16,
      vgaGainDb: 20,
      rfAmplifierEnabled: false,
    });
    expect(report.receiver).not.toHaveProperty("exactFrequencyHz");
    expect(report.notes).toBe("Stable for ten minutes.");
    expect(report.redaction.exactFrequencyIncluded).toBe(false);
  });

  it("includes the tuned frequency only after explicit opt-in", () => {
    const report = buildCompatibilityReport(context, {
      observations: [{ service: "audio", result: "degraded" }],
      includeExactFrequency: true,
    });
    expect(report.receiver.exactFrequencyHz).toBe(91_400_000);
    expect(report.redaction.exactFrequencyIncluded).toBe(true);
  });
});

// @vitest-environment jsdom
import { beforeEach, expect, it } from "vitest";
import {
  AUTO_REPORT_KEY,
  DiagnosticRecorder,
  MAX_DIAGNOSTIC_EVENTS,
  MAX_DIAGNOSTIC_SNAPSHOTS,
  loadAutoReportPreference,
  saveAutoReportPreference,
} from "./diagnosticRecorder";
import { buildDiagnosticReport, MAX_REPORT_BYTES } from "./reportBuilder";

beforeEach(() => localStorage.clear());

it("bounds, deduplicates and isolates diagnostic history", () => {
  const recorder = new DiagnosticRecorder();
  const repeat = () =>
    recorder.record({
      area: "receiver",
      code: "FAIL",
      severity: "error",
      error: new Error("first"),
    });
  repeat();
  repeat();
  expect(recorder.getEvents()).toHaveLength(1);
  expect(recorder.getEvents()[0]?.count).toBe(2);
  for (let index = 0; index < MAX_DIAGNOSTIC_EVENTS + 20; index++)
    recorder.record({
      area: "analysis",
      code: `CODE_${index}`,
      severity: "warning",
    });
  for (let index = 0; index < MAX_DIAGNOSTIC_SNAPSHOTS + 20; index++)
    recorder.addSnapshot({
      lifecycle: "running",
      visibility: "visible",
      analysis: { index },
    });
  expect(recorder.getEvents()).toHaveLength(MAX_DIAGNOSTIC_EVENTS);
  expect(recorder.getSnapshots()).toHaveLength(MAX_DIAGNOSTIC_SNAPSHOTS);
  const copy = recorder.getSnapshots();
  copy[0]!.analysis.index = -1;
  expect(recorder.getSnapshots()[0]!.analysis.index).not.toBe(-1);
});

it("keeps automatic reports off until the user opts in", () => {
  expect(loadAutoReportPreference()).toBe(false);
  saveAutoReportPreference(true);
  expect(localStorage.getItem(AUTO_REPORT_KEY)).toBe("true");
  expect(loadAutoReportPreference()).toBe(true);
  saveAutoReportPreference(false);
  expect(localStorage.getItem(AUTO_REPORT_KEY)).toBe("false");
  expect(loadAutoReportPreference()).toBe(false);
});

it("builds a bounded redacted report and includes frequency only by request", () => {
  const recorder = new DiagnosticRecorder();
  for (let index = 0; index < 100; index++)
    recorder.record({
      area: "application",
      code: `FAIL_${index}`,
      severity: "fatal",
      error: new Error("x".repeat(500)),
      context: { sampleRateHz: 2_400_000 },
    });
  const context = {
    lifecycle: "error",
    source: "hackrf",
    mode: "WBFM",
    sampleRateHz: 9_600_000,
    bandwidthHz: 180_000,
    gainMode: "manual",
    firmwareVersion: "1.2.3",
    recordingActive: false,
    exactFrequencyHz: 91_400_000,
  };
  const redacted = buildDiagnosticReport(recorder, context, {
    trigger: "manual",
  });
  expect(redacted.receiver).not.toHaveProperty("exactFrequencyHz");
  expect(redacted.redaction.omitted).toContain("usbSerial");
  expect(redacted.redaction.omitted).toContain("ipAddress");
  expect(
    new TextEncoder().encode(JSON.stringify(redacted)).byteLength,
  ).toBeLessThanOrEqual(MAX_REPORT_BYTES);
  expect(
    buildDiagnosticReport(recorder, context, {
      trigger: "manual",
      includeExactFrequency: true,
    }).receiver.exactFrequencyHz,
  ).toBe(91_400_000);
});

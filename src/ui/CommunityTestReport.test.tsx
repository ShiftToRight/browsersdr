// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { CommunityTestReport } from "./CommunityTestReport";
import type { CompatibilityReportContext } from "../diagnostics/compatibilityTypes";
import { sendCommunityReport } from "../diagnostics/communityReports";
vi.mock("../diagnostics/communityReports", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../diagnostics/communityReports")>()),
  COMMUNITY_BUILD: {
    id: "dialog-fixture",
    version: "1.0.0-rc.1",
    builtAt: "2026-10-12T00:00:00.000Z",
  },
  sendCommunityReport: vi.fn(async () => ({
    reference: `BC-${"a".repeat(24)}`,
    receipt: "b".repeat(64),
  })),
}));
const context: CompatibilityReportContext = {
  sessionGeneration: 1,
  source: "hackrf",
  deviceProfile: "HackRF Pro",
  mode: "WBFM",
  lifecycle: "running",
  sampleRateHz: 9600000,
  nativeSampleRateHz: 76800000,
  bandwidthHz: 180000,
  squelch: 0,
  gainMode: "staged",
  gainDb: null,
  lnaGainCode: 16,
  vgaGainDb: 20,
  rfAmplifierEnabled: false,
  antennaPowerEnabled: false,
  firmwareVersion: "2026.1.3",
  usbApiVersion: 0x110,
  protocolProfile: "hackrf-pro-stable-2026-v1",
  recordingActive: false,
  audioState: "running",
};
let root: Root | undefined;
afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  root = undefined;
  document.body.innerHTML = "";
  vi.clearAllMocks();
});
function button(text: string) {
  const found = Array.from(
    document.querySelectorAll<HTMLButtonElement>("button"),
  ).find((b) => b.textContent?.trim() === text);
  if (!found) throw new Error(text);
  return found;
}
async function render(value = context) {
  if (!root) {
    const host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
  }
  await act(async () =>
    root!.render(
      <CommunityTestReport
        context={value}
        renderer="canvas2d"
        onSent={() => undefined}
      />,
    ),
  );
}
async function fill() {
  await act(async () => button("Report this test").click());
  const select = document.querySelector<HTMLSelectElement>(
    '[aria-label="RDS test result"]',
  )!;
  await act(async () => {
    select.value = "working";
    select.dispatchEvent(new Event("change", { bubbles: true }));
  });
  const input = document.querySelector<HTMLInputElement>(
    '[aria-label="Test duration (minutes)"]',
  )!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      "value",
    )!.set!.call(input, "10");
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
it("allows a stopped session but blocks a new acquisition generation or changed rate before sending", async () => {
  await render();
  await fill();
  expect(button("Send community report").disabled).toBe(false);
  await render({ ...context, lifecycle: "connected" });
  expect(button("Send community report").disabled).toBe(false);
  await render({ ...context, sessionGeneration: 2 });
  expect(button("Send community report").disabled).toBe(true);
  expect(document.querySelector('[role="alert"]')?.textContent).toContain(
    "setup changed",
  );
  expect(sendCommunityReport).not.toHaveBeenCalled();
  await render({ ...context, sampleRateHz: 2400000 });
  expect(button("Send community report").disabled).toBe(true);
});
it("keeps defaults untested, sends the frozen renderer, and prevents double sends", async () => {
  await render();
  await fill();
  await act(async () => {
    button("Send community report").click();
    button("Send community report").click();
  });
  expect(sendCommunityReport).toHaveBeenCalledTimes(1);
  expect(vi.mocked(sendCommunityReport).mock.calls[0]?.[0]).toMatchObject({
    environment: { renderer: "canvas2d" },
    observations: [{ feature: "rds", result: "working" }],
    durationMinutes: 10,
  });
});
it("offers only the selected SRD protocol rather than claiming every SRD decoder", async () => {
  await render({ ...context, mode: "SRD", srdProtocol: "fineoffset-wh51" });
  await act(async () => button("Report this test").click());
  expect(
    document.querySelector('[aria-label="SRD WH51 test result"]'),
  ).not.toBeNull();
  expect(
    document.querySelector('[aria-label="SRD Acurite test result"]'),
  ).toBeNull();
});

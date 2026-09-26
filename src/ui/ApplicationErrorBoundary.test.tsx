// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { defaultDiagnosticRecorder } from "../diagnostics/diagnosticRecorder";
import { ApplicationErrorBoundary } from "./ApplicationErrorBoundary";

function Broken(): never { throw new Error("render exploded"); }

beforeEach(() => { vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true); defaultDiagnosticRecorder.clear(); });
afterEach(() => { vi.unstubAllGlobals(); document.body.replaceChildren(); });

it("keeps recovery and diagnostic download available after a React render crash", async () => {
  const host = document.createElement("div"); document.body.append(host); const root = createRoot(host);
  await act(async () => root.render(<ApplicationErrorBoundary><Broken /></ApplicationErrorBoundary>));
  expect(document.body.textContent).toContain("BrowserSDR needs to reload");
  expect(document.body.textContent).toContain("Download diagnostic JSON");
  expect(defaultDiagnosticRecorder.getEvents().some((event) => event.code === "REACT_RENDER_CRASH")).toBe(true);
  await act(async () => root.unmount());
});

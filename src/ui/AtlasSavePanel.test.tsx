// @vitest-environment jsdom

import { StrictMode, act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type {
  AtlasTransferRequest,
  AtlasTransferResult,
  AtlasTransferSnapshot,
} from "../radio/atlasTransfer";
import type { PreparedRecordingExport } from "../radio/recordingExport";
import { AtlasSavePanel } from "./AtlasSavePanel";

const PREPARED: PreparedRecordingExport = {
  format: "sigmf",
  basename: "capture-<unsafe>",
  sampleCount: 2,
  files: [
    {
      name: "capture.sigmf-data",
      contents: new Uint8Array([1, 2, 3, 4]),
      type: "application/octet-stream",
    },
    {
      name: "capture.sigmf-meta",
      contents: "{}",
      type: "application/json",
    },
  ],
};

const IDLE: AtlasTransferSnapshot = {
  state: "idle",
  generation: 0,
  bytesTransferred: "0",
  totalBytes: "0",
  activeParts: 0,
  peakActiveParts: 0,
  peakBufferedBytes: 0,
};

const SAVED_RESULT: AtlasTransferResult = {
  recordingId: "30000000-0000-4000-8000-000000000001",
  recordingRevisionId: "40000000-0000-4000-8000-000000000001",
  recordingUrl: "/#/recordings/30000000-0000-4000-8000-000000000001",
  dataSha256: "a".repeat(64),
  metadataSha256: "b".repeat(64),
  compatibility: {
    contractVersion: "signalexplorer-browsersdr-integration-v1",
    schemaDigestSha256:
      "d00c6936ef6d743584eaf686a8ace0c72ff4bf286255e7b4d77fbeda8f6ef164",
    archiveEligible: true,
    analysisEligible: true,
    byteLength: "4",
    sampleCount: "2",
    issues: [],
  },
  analysis: {
    status: "scheduled",
    run: {
      id: "50000000-0000-4000-8000-000000000001",
      recording_id: "30000000-0000-4000-8000-000000000001",
      recording_revision_id: "40000000-0000-4000-8000-000000000001",
      status: "partial",
      recording_url: "/#/recordings/30000000-0000-4000-8000-000000000001",
      result_url: "/#/runs/50000000-0000-4000-8000-000000000001",
    },
  },
};

class FakeController {
  snapshot = { ...IDLE };
  listeners = new Set<(snapshot: AtlasTransferSnapshot) => void>();
  start =
    vi.fn<(request: AtlasTransferRequest) => Promise<AtlasTransferResult>>();
  cancel = vi.fn(async () => undefined);
  getSnapshot = () => ({ ...this.snapshot });
  subscribe = (listener: (snapshot: AtlasTransferSnapshot) => void) => {
    this.listeners.add(listener);
    listener(this.getSnapshot());
    return () => this.listeners.delete(listener);
  };
  emit(change: Partial<AtlasTransferSnapshot>) {
    this.snapshot = { ...this.snapshot, ...change };
    for (const listener of this.listeners) listener(this.getSnapshot());
  }
}

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  vi.unstubAllGlobals();
  document.body.replaceChildren();
});

function input(label: string): HTMLInputElement {
  return host.querySelector(`input[aria-label="${label}"]`)!;
}

async function setInput(
  element: HTMLInputElement,
  value: string,
): Promise<void> {
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      "value",
    )!.set!;
    setter.call(element, value);
    element.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

it("requires an explicit action and renders verified save plus partial analysis links", async () => {
  const controller = new FakeController();
  controller.start.mockImplementation(async (request) => {
    expect(request).toEqual({
      userToken: "t".repeat(32),
      title: "Capture title",
      sourceKind: "synthetic",
      analyzeAfterSave: true,
    });
    controller.emit({
      state: "uploading",
      generation: 1,
      bytesTransferred: "4",
      totalBytes: "6",
      activeParts: 1,
    });
    await Promise.resolve();
    controller.emit({
      state: "saved",
      bytesTransferred: "6",
      recordingId: SAVED_RESULT.recordingId,
      recordingRevisionId: SAVED_RESULT.recordingRevisionId,
      recordingUrl: SAVED_RESULT.recordingUrl,
    });
    return SAVED_RESULT;
  });

  await act(async () =>
    root.render(
      <AtlasSavePanel
        prepared={PREPARED}
        sourceKind="synthetic"
        createController={() => controller}
      />,
    ),
  );

  expect(controller.start).not.toHaveBeenCalled();
  expect(host.textContent).toContain("nothing has been sent");
  expect(host.textContent).toContain(
    "Offline ZIP and separate-file downloads remain available",
  );
  expect(host.querySelector("unsafe")).toBeNull();
  expect(input("SigIntAtlas user token").type).toBe("password");

  await setInput(input("SigIntAtlas recording title"), "Capture title");
  await setInput(input("SigIntAtlas user token"), "t".repeat(32));
  await act(async () => {
    (host.querySelector('input[type="checkbox"]') as HTMLInputElement).click();
    (
      Array.from(host.querySelectorAll("button")).find(
        (button) => button.textContent === "Save to SigIntAtlas",
      ) as HTMLButtonElement
    ).click();
  });

  await vi.waitFor(() =>
    expect(host.textContent).toContain("completed with partial coverage"),
  );
  expect(
    host.querySelector<HTMLAnchorElement>('a[href^="/#/recordings/"]')
      ?.textContent,
  ).toBe("Open saved recording");
  expect(
    host.querySelector<HTMLAnchorElement>('a[href^="/#/runs/"]')?.textContent,
  ).toBe("Open analysis result");
  expect(input("SigIntAtlas user token").value).toBe("");
});

it("surfaces authentication failure and retries the same prepared pair", async () => {
  const controller = new FakeController();
  controller.start
    .mockImplementationOnce(async () => {
      controller.emit({
        state: "failed",
        generation: 1,
        errorCode: "session_expired",
        message: "Session expired.",
      });
      throw new Error("Session expired.");
    })
    .mockImplementationOnce(async () => {
      controller.emit({
        state: "saved",
        recordingUrl: SAVED_RESULT.recordingUrl,
      });
      return { ...SAVED_RESULT, analysis: { status: "not-requested" } };
    });
  await act(async () =>
    root.render(
      <AtlasSavePanel
        prepared={PREPARED}
        createController={() => controller}
      />,
    ),
  );
  await setInput(input("SigIntAtlas user token"), "t".repeat(32));
  await act(async () => {
    (host.querySelector("button") as HTMLButtonElement).click();
  });
  await vi.waitFor(() => expect(host.textContent).toContain("session_expired"));
  expect(host.textContent).toContain("Retry save");
  await act(async () => {
    (
      Array.from(host.querySelectorAll("button")).find(
        (button) => button.textContent === "Retry save",
      ) as HTMLButtonElement
    ).click();
  });
  await vi.waitFor(() => expect(controller.start).toHaveBeenCalledTimes(2));
});

it("survives Strict Mode effect replay, then cancels on unmount and ignores a late completion", async () => {
  const controllers: FakeController[] = [];
  const pending: Array<(result: AtlasTransferResult) => void> = [];
  const createController = () => {
    const controller = new FakeController();
    controller.start.mockImplementation(
      () => new Promise((resolve) => pending.push(resolve)),
    );
    controllers.push(controller);
    return controller;
  };
  await act(async () =>
    root.render(
      <StrictMode>
        <AtlasSavePanel
          prepared={PREPARED}
          createController={createController}
        />
      </StrictMode>,
    ),
  );
  expect(controllers.length).toBeGreaterThanOrEqual(2);
  const subscribedController = controllers.find(
    (controller) => controller.listeners.size > 0,
  )!;
  expect(subscribedController.cancel).not.toHaveBeenCalled();
  await setInput(input("SigIntAtlas user token"), "t".repeat(32));
  await act(async () => {
    (host.querySelector("button") as HTMLButtonElement).click();
  });
  await act(async () => root.unmount());
  root = createRoot(host);
  const activeController = controllers.find(
    (controller) => controller.start.mock.calls.length > 0,
  )!;
  expect(activeController).toBe(subscribedController);
  expect(activeController.cancel.mock.calls.length).toBeGreaterThanOrEqual(1);
  await act(async () => pending.at(-1)?.(SAVED_RESULT));
  expect(host.textContent).toBe("");
});

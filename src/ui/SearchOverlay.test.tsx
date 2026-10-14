// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { beforeEach, afterEach, expect, it, vi } from "vitest";
import { publicStationFixture as fixture } from "../testing/publicStationFixture";
import { SearchOverlay, type SearchOverlayProps } from "./SearchOverlay";
import {
  PublicCatalogError,
  PublicStationClient,
} from "../radio/publicStationClient";
let root: Root, host: HTMLDivElement, props: SearchOverlayProps;
const id = "00000000-0000-4000-8000-000000000001";
let detail = structuredClone(fixture.details[id]!);
let calls: string[];
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("requestAnimationFrame", (fn: () => void) => {
    fn();
    return 1;
  });
  vi.stubGlobal("matchMedia", () => ({ matches: true }));
  HTMLDialogElement.prototype.showModal = function () {
    this.open = true;
  };
  HTMLDialogElement.prototype.close = function () {
    this.open = false;
  };
  detail = structuredClone(fixture.details[id]!);
  calls = [];
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  props = {
    favorites: [],
    frequencyHz: 100e6,
    mode: "WBFM",
    contextKey: "initial",
    onPreview: () => "Preview settings; Start remains manual",
    onRecall: vi.fn(async () => "Guide applied"),
    onUseStation: vi.fn(async () => "Candidate applied"),
    onFavorite: vi.fn(),
    client: new PublicStationClient(async (input) => {
      calls.push(String(input));
      return Response.json(
        String(input).includes("/transmissions?")
          ? fixture.references
          : String(input).includes("/stations/")
            ? detail
            : fixture.queries[0]!.response,
      );
    }),
  };
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});
const button = (text: string) =>
  Array.from(document.querySelectorAll("button")).find(
    (b) => b.textContent?.trim() === text,
  )!;
async function render() {
  await act(async () => root.render(<SearchOverlay {...props} />));
}
async function click(text: string) {
  await act(async () => button(text).click());
  await act(async () => {
    await vi.dynamicImportSettled();
  });
}
async function search() {
  await act(async () => {
    document
      .querySelector("form")!
      .dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  });
}
it("mount/open/preview are passive and apply is deliberate without personal connection calls", async () => {
  await render();
  await click("Search");
  expect(calls).toEqual([]);
  await click("Preview ADS-B / 1090ES");
  expect(props.onRecall).not.toHaveBeenCalled();
  await click("Apply to receiver");
  expect(props.onRecall).toHaveBeenCalledOnce();
  expect(props.onUseStation).not.toHaveBeenCalled();
  expect(
    vi.mocked(props.onRecall).mock.calls[0]![0].atlasReference,
  ).toBeUndefined();
  expect(calls).toEqual([]);
});
it("station apply performs fresh public detail and refuses changed/retired references", async () => {
  await render();
  await click("Search");
  await search();
  await click("Show references for ENERGY Berlin (illustrative)");
  await click("Preview 103.4 MHz");
  expect(props.onUseStation).not.toHaveBeenCalled();
  detail.station.publication_version++;
  await click("Apply to receiver");
  expect(document.body.textContent).toContain("catalog or page cursor changed");
  expect(props.onUseStation).not.toHaveBeenCalled();
  detail = structuredClone(fixture.details[id]!);
  await click("Apply to receiver");
  expect(props.onUseStation).toHaveBeenCalledOnce();
  expect(calls.filter((c) => c.includes("/stations/"))).toHaveLength(4);
});
it("keeps browsing available during recording and never applies a source-stale preview", async () => {
  props.blockedReason = "Recording active";
  await render();
  await click("Search");
  await search();
  await click("Show references for ENERGY Berlin (illustrative)");
  await click("Preview 103.4 MHz");
  expect(button("Apply to receiver").disabled).toBe(true);
  expect(calls).toHaveLength(2);
  props.blockedReason = undefined;
  props.contextKey = "another-source";
  await render();
  expect(document.body.textContent).toContain("Receiver context changed");
  expect(button("Apply to receiver").disabled).toBe(true);
});
it("closing during delayed public detail cancels selection and restores trigger focus", async () => {
  let release!: (value: Response) => void;
  vi.spyOn(props.client!, "reference").mockImplementation(async () => {
    await new Promise<Response>((r) => {
      release = r;
    });
    return { ...detail.station, transmissions: fixture.references.items };
  });
  await render();
  await click("Search");
  await search();
  await click("Show references for ENERGY Berlin (illustrative)");
  await click("Preview 103.4 MHz");
  await act(async () => button("Apply to receiver").click());
  await click("Close Search");
  await act(async () => release(Response.json(detail)));
  expect(props.onUseStation).not.toHaveBeenCalled();
  expect(document.activeElement).toBe(button("Search"));
});
it("rejects a source change while detail is pending, even if callbacks from the old render survive", async () => {
  let release!: () => void;
  vi.spyOn(props.client!, "reference").mockImplementation(async () => {
    await new Promise<void>((r) => {
      release = r;
    });
    return { ...detail.station, transmissions: fixture.references.items };
  });
  await render();
  await click("Search");
  await search();
  await click("Show references for ENERGY Berlin (illustrative)");
  await click("Preview 103.4 MHz");
  await act(async () => button("Apply to receiver").click());
  props.contextKey = "new-source";
  await render();
  await act(async () => release());
  expect(props.onUseStation).not.toHaveBeenCalled();
});

it("refreshes the same header after an expired reference cursor without reusing the failed reference pager", async () => {
  vi.spyOn(props.client!, "transmissions").mockRejectedValueOnce(
    new PublicCatalogError(409, "cursor_expired"),
  );
  await render();
  await click("Search");
  await search();
  await click("Show references for ENERGY Berlin (illustrative)");
  expect(document.body.textContent).toContain("Search Atlas again to refresh");
  await search();
  await click("Show references for ENERGY Berlin (illustrative)");
  expect(document.body.textContent).toContain("Reference page 1");
  await click("Preview 103.4 MHz");
  expect(button("Apply to receiver").disabled).toBe(false);
});

it("shared-frequency preview is passive and applies a frequency without station identity or network calls", async () => {
  await render();
  await click("Search");
  await click("Preview 869.618 MHz with WBFM");
  expect(props.onRecall).not.toHaveBeenCalled();
  expect(calls).toEqual([]);
  await click("Apply to receiver");
  expect(props.onUseStation).not.toHaveBeenCalled();
  const bookmark = vi.mocked(props.onRecall).mock.calls[0]![0];
  expect(bookmark.frequencyHz).toBe(869618000);
  expect(bookmark.settings.mode).toBe("WBFM");
  expect(bookmark.atlasReference).toBeUndefined();
  expect(calls).toEqual([]);
});

it("applies an HF USB dial from shared search without inventing station identity", async () => {
  await render();
  await click("Search");
  await act(async () => {
    const input = document.querySelector<HTMLInputElement>(
      'input[type="search"]',
    )!;
    Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      "value",
    )!.set!.call(input, "ft8 20m");
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await click("Preview 14.074 MHz with USB");
  expect(props.onRecall).not.toHaveBeenCalled();
  await click("Apply to receiver");
  const bookmark = vi.mocked(props.onRecall).mock.calls[0]![0];
  expect(bookmark.frequencyHz).toBe(14074000);
  expect(bookmark.settings.mode).toBe("USB");
  expect(bookmark.atlasReference).toBeUndefined();
  expect(props.onUseStation).not.toHaveBeenCalled();
  expect(calls).toEqual([]);
});

it("keeps long plans collapsed until expanded and separates spacing from modem parameters", async () => {
  await render();
  await click("Search");
  const plan = [...document.querySelectorAll("summary")].find((item) =>
    item.textContent?.startsWith("US915 · Uplink 125 kHz"),
  )!;
  expect(plan.parentElement!.querySelectorAll("article")).toHaveLength(0);
  await act(async () => {
    (plan.parentElement as HTMLDetailsElement).open = true;
    plan.parentElement!.dispatchEvent(new Event("toggle"));
  });
  expect(plan.parentElement!.querySelectorAll("article")).toHaveLength(64);
  const ble = document.querySelector(
    '[aria-label="Bluetooth LE primary advertising channel 37"]',
  )!;
  expect(ble.textContent).toContain("Channel spacing: 2000 kHz");
  expect(ble.textContent).not.toContain("SF");
  expect(ble.textContent).not.toContain("CR ");
});

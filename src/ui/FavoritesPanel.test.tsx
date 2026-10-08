// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useFavorites } from "./FavoritesPanel";
import {
  BOOKMARK_KEY,
  exportBookmarks,
  type Bookmark,
} from "../radio/bookmarks";
import { defaultModeSettings } from "../radio/receiverConfig";
const item: Bookmark = {
  id: "00000000-0000-4000-8000-000000000001",
  name: "Test",
  frequencyHz: 100e6,
  settings: defaultModeSettings("WBFM"),
  tags: [],
  notes: "",
};
let root: Root, host: HTMLDivElement;
function Probe() {
  const favorites = useFavorites();
  return (
    <>
      <button onClick={() => favorites.change((current) => [...current, item])}>
        Save
      </button>
      <output>{JSON.stringify(favorites.items)}</output>
      <p>{favorites.message}</p>
    </>
  );
}
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  localStorage.clear();
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  host.remove();
  localStorage.clear();
});
it("keeps newly saved favorites exportable in this tab when persistent writes fail", async () => {
  await act(async () => root.render(<Probe />));
  vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
    throw new DOMException("Full", "QuotaExceededError");
  });
  await act(async () => host.querySelector("button")!.click());
  expect(host.querySelector("output")!.textContent).toBe(
    JSON.stringify([item]),
  );
  expect(host.textContent).toContain("Export a backup before closing it.");
  expect(localStorage.getItem(BOOKMARK_KEY)).toBeNull();
});
it("uses in-tab favorites when browser storage cannot be accessed", async () => {
  vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
    throw new DOMException("Blocked", "SecurityError");
  });
  await act(async () => root.render(<Probe />));
  expect(host.textContent).toContain("Browser storage is unavailable.");
  await act(async () => host.querySelector("button")!.click());
  expect(host.querySelector("output")!.textContent).toBe(
    JSON.stringify([item]),
  );
});
it("refreshes favorites from another tab and preserves the stored bytes on malformed updates", async () => {
  await act(async () => root.render(<Probe />));
  localStorage.setItem(BOOKMARK_KEY, exportBookmarks([item]));
  await act(async () =>
    window.dispatchEvent(new StorageEvent("storage", { key: BOOKMARK_KEY })),
  );
  expect(host.querySelector("output")!.textContent).toBe(
    JSON.stringify([item]),
  );
  localStorage.setItem(BOOKMARK_KEY, "malformed");
  await act(async () =>
    window.dispatchEvent(new StorageEvent("storage", { key: BOOKMARK_KEY })),
  );
  expect(host.textContent).toContain(
    "Existing browser data has been preserved.",
  );
  expect(localStorage.getItem(BOOKMARK_KEY)).toBe("malformed");
});

// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { RecordingLibrary } from "./RecordingLibrary";
import {
  listRecordings,
  openRecording,
  type LibraryEntry,
} from "../radio/recordingLibrary";
import { createDeterministicRecordingFixture } from "../testing/recordingFixture";

vi.mock("../radio/recordingLibrary", () => ({
  listRecordings: vi.fn(),
  openRecording: vi.fn(),
  deleteRecording: vi.fn(),
}));
afterEach(() => vi.clearAllMocks());
const entry: LibraryEntry = {
  id: "capture-fixture",
  state: "interrupted",
  bytes: 1024,
};
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

it("blocks replay and deletion while a refresh owns the listing lock, then permits opening", async () => {
  const listing = deferred<LibraryEntry[]>();
  vi.mocked(listRecordings).mockResolvedValue([entry]);
  vi.mocked(openRecording).mockResolvedValue(
    createDeterministicRecordingFixture(8),
  );
  const onOpen = vi.fn(async () => undefined);
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  const button = (name: string) =>
    Array.from(host.querySelectorAll<HTMLButtonElement>("button")).find(
      (b) => b.textContent === name,
    )!;
  try {
    await act(async () =>
      root.render(
        <RecordingLibrary blocked={false} revision="initial" onOpen={onOpen} />,
      ),
    );
    expect(button("Replay retained recording").disabled).toBe(false);
    vi.mocked(listRecordings).mockImplementationOnce(() => listing.promise);
    await act(async () => button("Refresh library").click());
    expect(button("Replay retained recording").disabled).toBe(true);
    expect(button("Delete retained recording").disabled).toBe(true);
    await act(async () => button("Replay retained recording").click());
    expect(openRecording).not.toHaveBeenCalled();
    await act(async () => listing.resolve([entry]));
    expect(button("Replay retained recording").disabled).toBe(false);
    await act(async () => button("Replay retained recording").click());
    expect(openRecording).toHaveBeenCalledWith(entry.id);
    expect(onOpen).toHaveBeenCalledWith(expect.any(Object), true);
  } finally {
    await act(async () => root.unmount());
    host.remove();
  }
});

it("coalesces overlapping revision refreshes and presents the latest listing before enabling actions", async () => {
  const first = deferred<LibraryEntry[]>();
  const latest: LibraryEntry = { ...entry, id: "capture-latest" };
  vi.mocked(listRecordings)
    .mockImplementationOnce(() => first.promise)
    .mockResolvedValue([latest]);
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  const onOpen = vi.fn(async () => undefined);
  const render = (revision: string) =>
    root.render(
      <RecordingLibrary blocked={false} revision={revision} onOpen={onOpen} />,
    );
  try {
    await act(async () => render("first"));
    await act(async () => render("second"));
    await act(async () => render("third"));
    expect(listRecordings).toHaveBeenCalledTimes(1);
    await act(async () => first.resolve([entry]));
    expect(listRecordings).toHaveBeenCalledTimes(2);
    expect(
      host.querySelector(".recording-library-entry")?.textContent,
    ).toContain("capture-latest");
    expect(
      host.querySelector(".recording-library-entry")?.textContent,
    ).not.toContain("capture-fixture");
  } finally {
    await act(async () => root.unmount());
    host.remove();
  }
});

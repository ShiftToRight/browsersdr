// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { RecordingLibrary } from "./RecordingLibrary";
import {
  listRecordings,
  openRecording,
  deleteRecording,
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

it("sorts newest first deterministically and requires explicit, cancellable deletion", async () => {
  vi.mocked(listRecordings).mockResolvedValue([{ ...entry, id: "2026-10-15-old" }, { ...entry, id: "2026-10-16-new" }]);
  const host = document.createElement("div"); document.body.append(host);
  const root = createRoot(host);
  try {
    await act(async () => root.render(<RecordingLibrary blocked={false} revision="initial" onOpen={async () => undefined} />));
    const rows = host.querySelectorAll<HTMLElement>(".recording-library-entry");
    expect(rows[0]!.textContent).toContain("2026-10-16-new");
    const button = (name: string) => [...rows[0]!.querySelectorAll("button")].find(b => b.textContent === name)!;
    await act(async () => button("Delete retained recording").click());
    expect(deleteRecording).not.toHaveBeenCalled();
    await act(async () => button("Keep recording").click());
    expect(host.querySelector(".library-delete-confirm")).toBeNull();
    await act(async () => button("Delete retained recording").click());
    await act(async () => button("Confirm delete recording").click());
    expect(deleteRecording).toHaveBeenCalledExactlyOnceWith("2026-10-16-new");
  } finally { await act(async () => root.unmount()); host.remove(); }
});
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
it("explains the live receiver prerequisite beside retained replay", async () => {
  vi.mocked(listRecordings).mockResolvedValue([entry]);
  const host = document.createElement("div"); document.body.append(host); const root = createRoot(host);
  try {
    await act(async () => root.render(<RecordingLibrary blocked blockedReason="Stop reception before replaying a library recording." revision="reason" onOpen={async () => undefined} />));
    const replay = [...host.querySelectorAll("button")].find(button => button.textContent === "Replay retained recording")!;
    expect(replay.disabled).toBe(true);
    expect(host.querySelector(`#${replay.getAttribute("aria-describedby")}`)!.textContent).toContain("Stop reception");
  } finally { await act(async () => root.unmount()); host.remove(); }
});

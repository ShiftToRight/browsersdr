// @vitest-environment jsdom
import { act, StrictMode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import fixture from "../testing/fixtures/atlas/browsersdr-station-search-v1.json";
import { AtlasClient } from "../radio/atlasClient";
import { AtlasConnection } from "../radio/atlasConnection";
import { AtlasCredentialStore } from "../radio/atlasCredentials";
import { AtlasStationSearchPanel } from "./AtlasStationSearchPanel";
let root: Root, host: HTMLDivElement, connection: AtlasConnection;
let calls: string[],
  current: (typeof fixture.pages.first.items)[0],
  result: typeof fixture.pages.first | typeof fixture.pages.last;
const onUse = vi.fn(
  async () => "Receiver candidate selected. Start remains manual.",
);
const onOpenSettings = vi.fn();
const onFavorite = vi.fn();
beforeEach(() => {
  calls = [];
  current = structuredClone(fixture.pages.first.items[0]!);
  result = structuredClone(fixture.pages.first);
  onUse.mockClear();
  onFavorite.mockClear();
  onOpenSettings.mockClear();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const credentials = new AtlasCredentialStore(localStorage, window);
  credentials.save("component-test-search-credential-".repeat(2), false);
  connection = new AtlasConnection(
    credentials,
    new AtlasClient({
      fetch: async (input) => {
        const path = String(input);
        calls.push(path);
        if (path.endsWith("/session"))
          return Response.json({
            operator_id: "viewer",
            expires_at: "2030-01-01T00:00:00Z",
            csrf_token: "csrf",
          });
        if (path.endsWith("/me"))
          return Response.json({ ...fixture.viewer, id: "viewer" });
        if (path.includes("/stations/")) return Response.json(current);
        return Response.json(result);
      },
    }),
  );
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  connection.dispose();
  connection.credentials.dispose();
  host.remove();
  localStorage.clear();
  vi.unstubAllGlobals();
});
async function render(blockedReason?: string) {
  await act(async () =>
    root.render(
      <StrictMode>
        <AtlasStationSearchPanel
          connection={connection}
          channelFrequencyHz={100e6}
          channelBandwidthHz={150000}
          blockedReason={blockedReason}
          onFavorite={onFavorite}
          onUse={onUse}
          onOpenSettings={onOpenSettings}
        />
      </StrictMode>,
    ),
  );
}
function button(name: string) {
  return Array.from(host.querySelectorAll("button")).find(
    (b) => b.textContent === name,
  )!;
}
async function search() {
  await act(async () => {
    host
      .querySelector("form")!
      .dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  });
}
async function select(index: number, value: string) {
  await act(async () => {
    const s = host.querySelectorAll("select")[index]!;
    s.value = value;
    s.dispatchEvent(new Event("change", { bubbles: true }));
  });
}
it("Strict Mode/search mount is idle, names render as text and multiple references require an explicit choice", async () => {
  await render();
  expect(calls).toEqual([]);
  await search();
  expect(host.textContent).toContain("Example <Radio>");
  expect(host.querySelector("radio")).toBeNull();
  expect(host.textContent).toContain("verified catalog reference");
  expect(host.textContent).toContain("provisional catalog reference");
  expect(button("Use in receiver").disabled).toBe(true);
  expect(onUse).not.toHaveBeenCalled();
  const link = Array.from(host.querySelectorAll("a")).find(
    (a) => a.textContent === "Open in SigIntAtlas",
  )!;
  expect(link.href).toContain(`station_id=${current.id}`);
  expect(link.href).not.toContain("credential");
  await select(0, current.transmissions[0]!.id);
  expect(button("Use in receiver").disabled).toBe(false);
  await act(async () => button("Use in receiver").click());
  expect(onUse).toHaveBeenCalledWith(
    expect.objectContaining({
      station_id: current.id,
      transmission_id: current.transmissions[0]!.id,
      mode: "WBFM",
    }),
  );
  expect(calls.some((p) => p.includes("capabilities"))).toBe(false);
});
it("unsupported formats require deliberate analog mode; retired or changed references cannot silently tune", async () => {
  await render();
  await search();
  await select(0, current.transmissions[2]!.id);
  expect(button("Use in receiver").disabled).toBe(true);
  await select(1, "AM");
  expect(button("Use in receiver").disabled).toBe(false);
  current.transmissions[2]!.frequency_hz = 110e6;
  await act(async () => button("Use in receiver").click());
  expect(onUse).not.toHaveBeenCalled();
  expect(host.textContent).toContain("reference changed");
  current.transmissions = [];
  await act(async () => button("Use in receiver").click());
  expect(onUse).not.toHaveBeenCalled();
  expect(host.textContent).toContain("belonging");
});
it("stations without references stay linkable and capture conflicts block Use without blocking search", async () => {
  result = structuredClone(fixture.pages.last);
  await render("Discard the prepared capture first.");
  await search();
  expect(host.textContent).toContain("No transmission references");
  expect(button("Use in receiver")).toBeUndefined();
  expect(host.querySelector('a[href*="station_id"]')).not.toBeNull();
  result = structuredClone(fixture.pages.first);
  await search();
  await select(0, current.transmissions[0]!.id);
  expect(button("Use in receiver").disabled).toBe(true);
  await act(async () => button("Atlas settings").click());
  expect(onOpenSettings).toHaveBeenCalledOnce();
});
it("Around channel fills labeled MHz without sending a request; invalid ranges and Clear reset results", async () => {
  await render();
  await act(async () => button("Around channel").click());
  expect(
    Array.from(
      host.querySelectorAll<HTMLInputElement>('input[type="number"]'),
    ).map((i) => i.value),
  ).toEqual(["99.925", "100.075"]);
  expect(calls).toEqual([]);
  await search();
  expect(calls.at(-1)).toContain(
    "min_frequency_hz=99925000&max_frequency_hz=100075000",
  );
  await act(async () => button("Clear search").click());
  expect(host.querySelector("article")).toBeNull();
  await act(async () => {
    const i = host.querySelectorAll<HTMLInputElement>(
      'input[type="number"]',
    )[0]!;
    Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      "value",
    )!.set!.call(i, "1");
    i.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await search();
  expect(host.textContent).toContain("both frequency bounds");
});

it("saves a catalog favorite without receiver mutation, token export or claiming refreshed identity", async () => {
  await render("Stop recording before selecting a station.");
  await search();
  await select(0, current.transmissions[0]!.id);
  const before = [...calls];
  await act(async () => button("Save station favorite").click());
  expect(onFavorite).toHaveBeenCalledWith(
    expect.objectContaining({
      station_id: current.id,
      transmission_id: current.transmissions[0]!.id,
      frequency_hz: current.transmissions[0]!.frequency_hz,
    }),
  );
  expect(JSON.stringify(onFavorite.mock.calls)).not.toContain("credential");
  expect(onUse).not.toHaveBeenCalled();
  expect(calls).toEqual(before);
  expect(host.textContent).toContain("station identity is unconfirmed");
});

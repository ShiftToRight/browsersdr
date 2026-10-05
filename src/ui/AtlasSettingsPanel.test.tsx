// @vitest-environment jsdom
import { StrictMode, act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { AtlasClient } from "../radio/atlasClient";
import { AtlasConnection } from "../radio/atlasConnection";
import {
  AtlasCredentialStore,
  ATLAS_USER_TOKEN_KEY,
} from "../radio/atlasCredentials";
import { AtlasSettingsPanel } from "./AtlasSettingsPanel";

let root: Root, host: HTMLDivElement, connection: AtlasConnection;
let calls: Array<{ method: string; path: string }>;
const TOKEN = "settings-test-credential-".repeat(2);
beforeEach(() => {
  localStorage.clear();
  calls = [];
  const client = new AtlasClient({
    fetch: async (input, init) => {
      const path = String(input),
        method = init?.method ?? "GET";
      calls.push({ path, method });
      const body = path.endsWith("/me")
        ? {
            id: "viewer",
            display_name: "Viewer <name>",
            role: "viewer",
            token_id: null,
            bootstrap: false,
          }
        : {
            operator_id: "viewer",
            expires_at: "2030-01-01T00:00:00Z",
            csrf_token: "csrf",
          };
      return new Response(JSON.stringify(body), { status: 200 });
    },
  });
  connection = new AtlasConnection(
    new AtlasCredentialStore(localStorage, window),
    client,
  );
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
});
afterEach(async () => {
  await act(async () => root.unmount());
  connection.dispose();
  connection.credentials.dispose();
  host.remove();
  vi.unstubAllGlobals();
});
const button = (name: string) =>
  Array.from(host.querySelectorAll("button")).find(
    (value) => value.textContent === name,
  )!;
async function edit(token: string) {
  await act(async () => {
    const input = host.querySelector<HTMLInputElement>(
      'input[type="password"]',
    )!;
    Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      "value",
    )!.set!.call(input, token);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

it("Strict Mode mounts do not login; saving is separate from connection testing", async () => {
  await act(async () =>
    root.render(
      <StrictMode>
        <AtlasSettingsPanel connection={connection} />
      </StrictMode>,
    ),
  );
  expect(calls).toEqual([]);
  expect(
    host.querySelector<HTMLInputElement>('input[type="password"]')!.type,
  ).toBe("password");
  await edit(TOKEN);
  await act(async () => button("Save token").click());
  expect(localStorage.getItem(ATLAS_USER_TOKEN_KEY)).toBe(TOKEN);
  expect(calls).toEqual([]);
  await act(async () => button("Test connection").click());
  expect(calls).toEqual([
    { path: "/api/v1/session", method: "POST" },
    { path: "/api/v1/me", method: "GET" },
  ]);
  expect(host.textContent).toContain("Viewer <name>");
  expect(host.querySelector("name")).toBeNull();
  expect(host.textContent).toContain("Viewer access is read-only");
});

it("external credential changes replace stale editors and memory-only save removes persistence", async () => {
  await act(async () =>
    root.render(<AtlasSettingsPanel connection={connection} />),
  );
  await edit("unsaved draft");
  await act(async () => connection.saveToken(TOKEN, true));
  expect(
    host.querySelector<HTMLInputElement>('input[type="password"]')!.value,
  ).toBe(TOKEN);
  await act(async () =>
    host.querySelector<HTMLInputElement>('input[type="checkbox"]')!.click(),
  );
  await act(async () => button("Save token").click());
  expect(localStorage.getItem(ATLAS_USER_TOKEN_KEY)).toBeNull();
  expect(connection.credentials.getSnapshot()).toMatchObject({
    token: TOKEN,
    remember: false,
  });
  await act(async () => button("Forget token").click());
  expect(
    host.querySelector<HTMLInputElement>('input[type="password"]')!.value,
  ).toBe("");
});

it("an active transfer disables all credential/session mutations until released", async () => {
  await act(async () => connection.saveToken(TOKEN, true));
  await act(async () =>
    root.render(<AtlasSettingsPanel connection={connection} />),
  );
  let release!: () => void;
  const hold = new Promise<void>((resolve) => {
    release = resolve;
  });
  let transfer!: Promise<void>;
  await act(async () => {
    transfer = connection.withTransfer(
      TOKEN,
      () => hold,
      new AbortController().signal,
    );
  });
  for (const name of [
    "Save token",
    "Test connection",
    "Disconnect",
    "Forget token",
  ])
    expect(button(name).disabled).toBe(true);
  expect(host.textContent).toContain("cancel it before changing credentials");
  await act(async () => {
    release();
    await transfer;
  });
  expect(button("Save token").disabled).toBe(false);
});

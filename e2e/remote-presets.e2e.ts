import { expect, test, type Page, type WebSocketRoute } from "@playwright/test";
import { readFile } from "node:fs/promises";
const key = "browsersdr.remote-favorites.v1";
const address = "https://preset.example/";
const config = {
  center_freq: 10000000,
  samp_rate: 192000,
  fft_size: 128,
  audio_compression: "none",
  fft_compression: "none",
  start_freq: 10000000,
  start_mod: "am",
  sdr_id: "radio",
  profile_id: "hf",
};
const saved = {
  id: "11111111-1111-4111-8111-111111111111",
  name: "HF channel",
  notes: "private notes",
  kind: "openwebrx",
  address,
  profile: "radio|hf",
  tune: {
    frequency: 10020000,
    mode: "usb",
    lowCut: 300,
    highCut: 3000,
    squelch: -150,
  },
};
function backup(items: unknown[]) {
  return JSON.stringify({ schema: "browsersdr-remote-favorites-v1", items });
}
async function fixtures(page: Page) {
  const commands: string[] = [],
    closed: string[] = [],
    sockets: WebSocketRoute[] = [];
  let requestedBand: WebSocketRoute | undefined;
  await page.routeWebSocket("wss://preset.example/ws/", (socket) => {
    sockets.push(socket);
    socket.onClose(() => closed.push("openwebrx"));
    socket.onMessage((message) => {
      if (typeof message !== "string") return;
      commands.push(message);
      if (message.startsWith("SERVER DE CLIENT")) {
        socket.send("CLIENT DE SERVER server=openwebrx version=v1.2.126");
        socket.send(JSON.stringify({ type: "config", value: config }));
        socket.send(
          JSON.stringify({
            type: "profiles",
            value: [
              { id: "radio|hf", name: "HF" },
              { id: "radio|vhf", name: "VHF" },
            ],
          }),
        );
        socket.send(
          JSON.stringify({
            type: "modes",
            value: [
              { modulation: "am" },
              { modulation: "usb" },
              { modulation: "nfm" },
            ],
          }),
        );
      } else if (JSON.parse(message).type === "selectprofile")
        requestedBand = socket;
    });
  });
  await page.routeWebSocket(
    /wss:\/\/kiwi-preset\.example\/ws\/kiwi\/\d+\/(SND|W\/F)/,
    (socket) => {
      sockets.push(socket);
      socket.onClose(() => closed.push("kiwi"));
      socket.onMessage((message) => {
        if (typeof message !== "string") return;
        commands.push(message);
        if (message.startsWith("SET auth"))
          socket.send(
            socket.url().endsWith("SND")
              ? "MSG badp=0 version_maj=1 version_min=800 bandwidth=30000000 freq_offset=0 audio_rate=12000 sample_rate=12000.025"
              : "MSG badp=0 wf_fft_size=1024 zoom_max=14 zoom_cap=12 wf_setup",
          );
      });
    },
  );
  return {
    commands,
    closed,
    sockets,
    confirmBand: () =>
      requestedBand?.send(
        JSON.stringify({
          type: "config",
          value: {
            ...config,
            center_freq: 144000000,
            samp_rate: 2400000,
            start_freq: 144500000,
            profile_id: "vhf",
            start_mod: "nfm",
          },
        }),
      ),
  };
}
async function enter(page: Page) {
  await page
    .getByRole("combobox", { name: "Signal source", exact: true })
    .selectOption("remote");
  await expect(
    page.getByRole("heading", { name: "OpenWebRX", exact: true }),
  ).toBeVisible();
}
async function connect(page: Page) {
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  await expect(page.locator(".remote-header-status")).toContainText(
    "connected",
  );
}
async function overlay(page: Page) {
  await page.getByRole("button", { name: /^Remote favorites/ }).click();
  const dialog = page.getByRole("dialog", {
    name: "Remote favorites",
    exact: true,
  });
  await expect(dialog).toBeVisible();
  return dialog;
}
test("remote favorites save receivers/channels, load without starting, export and survive reload", async ({
  page,
}) => {
  const wire = await fixtures(page);
  await page.goto("/?browser-test=1");
  await enter(page);
  await page.getByLabel("Receiver website", { exact: true }).fill(address);
  let panel = await overlay(page);
  await expect(
    panel.getByRole("button", { name: "Save channel preset", exact: true }),
  ).toBeDisabled();
  await panel
    .getByRole("button", { name: "Save receiver", exact: true })
    .click();
  await panel.getByLabel("Preset name", { exact: true }).fill("My receiver");
  await panel
    .getByRole("button", { name: "Save remote favorite", exact: true })
    .click();
  expect(wire.sockets).toHaveLength(0);
  await panel.getByRole("button", { name: "Load", exact: true }).click();
  await expect(panel).not.toBeVisible();
  await connect(page);
  await page
    .getByRole("textbox", { name: "Remote channel MHz", exact: true })
    .fill("10.02");
  await page
    .getByRole("combobox", { name: "Remote mode", exact: true })
    .selectOption("usb");
  await page.getByRole("button", { name: "Listen", exact: true }).click();
  panel = await overlay(page);
  await panel
    .getByRole("button", { name: "Save channel preset", exact: true })
    .click();
  await panel.getByLabel("Preset name", { exact: true }).fill("My HF channel");
  await panel
    .getByRole("button", { name: "Save remote favorite", exact: true })
    .click();
  const startCount = wire.commands.filter((c) =>
    c.includes('"action":"start"'),
  ).length;
  await panel
    .locator("li")
    .filter({ hasText: "My HF channel" })
    .getByRole("button", { name: "Load", exact: true })
    .click();
  await expect.poll(() => wire.closed.length).toBe(1);
  expect(wire.sockets).toHaveLength(1);
  await connect(page);
  await expect(
    page.getByRole("button", { name: "Listen", exact: true }),
  ).toBeDisabled();
  await page
    .getByRole("textbox", { name: "Remote channel MHz", exact: true })
    .press("Enter");
  expect(
    wire.commands.filter((c) => c.includes('"action":"start"')),
  ).toHaveLength(startCount);
  await page
    .getByRole("button", { name: "Apply saved channel", exact: true })
    .click();
  await expect(
    page.getByRole("textbox", { name: "Remote channel MHz", exact: true }),
  ).toHaveValue("10.02");
  await expect(
    page.getByRole("button", { name: "Listen", exact: true }),
  ).toBeEnabled();
  expect(
    wire.commands.filter((c) => c.includes('"action":"start"')),
  ).toHaveLength(startCount);
  panel = await overlay(page);
  const downloaded = page.waitForEvent("download");
  await panel
    .getByRole("button", { name: "Export remote backup", exact: true })
    .click();
  const download = await downloaded;
  const contents = JSON.parse(await readFile((await download.path())!, "utf8"));
  expect(contents.items).toHaveLength(2);
  expect(contents.items[1].tune.frequency).toBe(10020000);
  await page.reload();
  expect(wire.sockets).toHaveLength(2);
  await enter(page);
  panel = await overlay(page);
  await expect(panel.locator("li")).toHaveCount(2);
  await page.setViewportSize({ width: 390, height: 844 });
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth),
  ).toBeLessThanOrEqual(390);
  await panel.press("Escape");
  await expect(panel).not.toBeVisible();
  await expect(
    page.getByRole("button", { name: /^Remote favorites/ }),
  ).toBeFocused();
});
test("saved OpenWebRX bands require explicit selection and matching confirmation before Listen", async ({
  page,
}) => {
  const wire = await fixtures(page);
  const vhf = {
    ...saved,
    name: "VHF preset",
    profile: "radio|vhf",
    tune: {
      ...saved.tune,
      frequency: 144500000,
      mode: "nfm",
      lowCut: -5000,
      highCut: 5000,
    },
  };
  await page.goto("/?browser-test=1");
  await page.evaluate(
    ({ key, contents }) => localStorage.setItem(key, contents),
    { key, contents: backup([vhf]) },
  );
  await enter(page);
  const panel = await overlay(page);
  await panel.getByRole("button", { name: "Load", exact: true }).click();
  await connect(page);
  expect(wire.commands.some((c) => c.includes("selectprofile"))).toBe(false);
  await page
    .getByRole("button", { name: "Apply saved channel", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "Listen", exact: true }),
  ).toBeDisabled();
  await expect
    .poll(() => wire.commands.some((c) => c.includes("selectprofile")))
    .toBe(true);
  wire.confirmBand();
  await expect(
    page.getByRole("textbox", { name: "Remote channel MHz", exact: true }),
  ).toHaveValue("144.5");
  await expect(
    page.getByRole("combobox", { name: "Remote mode", exact: true }),
  ).toHaveValue("nfm");
  await expect(
    page.getByRole("button", { name: "Listen", exact: true }),
  ).toBeEnabled();
  expect(wire.commands.some((c) => c.includes('"action":"start"'))).toBe(false);
});
test("remote favorite sharing previews on another page, preserves local settings and never auto-connects", async ({
  page,
  context,
}) => {
  const wire = await fixtures(page);
  await page.goto("/?browser-test=1");
  await page.evaluate(
    ({ key, contents }) => localStorage.setItem(key, contents),
    { key, contents: backup([saved]) },
  );
  await enter(page);
  const panel = await overlay(page);
  await panel
    .getByRole("button", { name: "Share preset", exact: true })
    .click();
  const link = await panel
    .getByLabel("Remote preset link", { exact: true })
    .inputValue();
  expect(link).not.toContain("browser-test");
  expect(link).not.toContain("private notes");
  expect(wire.sockets).toHaveLength(0);
  const recipient = await context.newPage();
  const recipientWire = await fixtures(recipient);
  await recipient.goto(link);
  const preview = recipient.getByRole("dialog", {
    name: "Shared remote preset",
    exact: true,
  });
  await expect(preview).toContainText(address);
  expect(recipientWire.sockets).toHaveLength(0);
  await preview
    .getByRole("button", { name: "Load remote preset", exact: true })
    .click();
  await expect(preview).not.toBeVisible();
  await expect(
    recipient.getByLabel("Receiver website", { exact: true }),
  ).toHaveValue(address);
  expect(recipientWire.sockets).toHaveLength(0);
  expect(new URL(recipient.url()).hash).toBe("");
  await recipient
    .getByRole("combobox", { name: "Signal source", exact: true })
    .selectOption("rtl-sdr");
  await expect(
    recipient.getByRole("spinbutton", {
      name: "Channel frequency",
      exact: true,
    }),
  ).toHaveValue("100.000");
  await expect(recipient.getByRole("combobox", { name: /^Mode/ })).toHaveValue(
    "WBFM",
  );
});
test("incoming remote presets refuse active local reception and retained captures without discarding data", async ({
  page,
}) => {
  await page.goto("/?browser-test=1");
  await page
    .getByRole("combobox", { name: "Signal source", exact: true })
    .selectOption("synthetic");
  await page.getByRole("button", { name: "Start demo", exact: true }).click();
  const shared = {
    schema: "browsersdr-remote-preset-v1",
    kind: "openwebrx",
    address,
    tune: saved.tune,
    profile: saved.profile,
  };
  await page.evaluate((value) => {
    location.hash = "remote=" + btoa(JSON.stringify(value)).replace(/=+$/, "");
  }, shared);
  const dialog = page.getByRole("dialog", {
    name: "Shared remote preset",
    exact: true,
  });
  await expect(
    dialog.getByRole("button", { name: "Load remote preset", exact: true }),
  ).toBeDisabled();
  await expect(dialog).toContainText("Stop receiving");
  await dialog
    .getByRole("button", { name: "Close remote preset", exact: true })
    .click();
  await page.getByRole("tab", { name: "Capture & replay" }).click();
  await page
    .getByRole("button", { name: "Start I/Q recording", exact: true })
    .click();
  await expect
    .poll(async () =>
      (await page.locator(".recording-state").innerText()).includes("MiB"),
    )
    .toBe(true);
  await page
    .getByRole("button", { name: "Stop recording", exact: true })
    .click();
  await page.getByRole("button", { name: "Stop", exact: true }).click();
  await page
    .getByRole("button", { name: "Review remote preset", exact: true })
    .click();
  await expect(
    dialog.getByRole("button", { name: "Load remote preset", exact: true }),
  ).toBeDisabled();
  await expect(dialog).toContainText("retained capture");
  await dialog
    .getByRole("button", { name: "Close remote preset", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "Discard prepared capture", exact: true }),
  ).toBeVisible();
});
test("Kiwi preset recall validates zoom and filter, stages edits and remains manual", async ({
  page,
}) => {
  const wire = await fixtures(page);
  const kiwi = {
    ...saved,
    name: "Kiwi channel",
    kind: "kiwi",
    address: "https://kiwi-preset.example/",
    profile: undefined,
    zoom: 8,
    tune: { ...saved.tune, frequency: 7100000 },
  };
  await page.goto("/?browser-test=1");
  await page.evaluate(
    ({ key, contents }) => localStorage.setItem(key, contents),
    { key, contents: backup([kiwi]) },
  );
  await enter(page);
  const panel = await overlay(page);
  await panel.getByRole("button", { name: "Load", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "KiwiSDR", exact: true }),
  ).toBeVisible();
  expect(wire.sockets).toHaveLength(0);
  await connect(page);
  await page
    .getByRole("button", { name: "Apply saved channel", exact: true })
    .click();
  await expect(
    page.getByRole("combobox", { name: "Waterfall zoom", exact: true }),
  ).toHaveValue("8");
  await expect(
    page.getByRole("combobox", { name: "Remote mode", exact: true }),
  ).toHaveValue("usb");
  await expect(page.locator(".remote-header-status")).toContainText(
    "connected",
  );
  const presets = await overlay(page);
  await presets.getByRole("button", { name: "Edit", exact: true }).click();
  await presets.getByLabel("Saved channel · MHz", { exact: true }).fill("100");
  await presets
    .getByRole("button", { name: "Save remote favorite", exact: true })
    .click();
  await presets.getByRole("button", { name: "Load", exact: true }).click();
  await expect.poll(() => wire.closed.length).toBe(2);
  await connect(page);
  await page
    .getByRole("button", { name: "Apply saved channel", exact: true })
    .click();
  await expect(page.getByRole("alert")).toContainText("fit within");
  await expect(
    page.getByRole("button", { name: "Listen", exact: true }),
  ).toBeDisabled();
});
test("remote backup corruption is preserved and explicit import recovers the separate collection", async ({
  page,
}) => {
  await page.goto("/?browser-test=1");
  await page.evaluate(
    (key) => localStorage.setItem(key, "broken retained data"),
    key,
  );
  await enter(page);
  const panel = await overlay(page);
  await expect(panel).toContainText("original data is preserved");
  await expect(
    panel.getByRole("button", { name: "Save receiver", exact: true }),
  ).toBeDisabled();
  expect(await page.evaluate((key) => localStorage.getItem(key), key)).toBe(
    "broken retained data",
  );
  await panel.locator('input[type="file"]').setInputFiles({
    name: "remote.json",
    mimeType: "application/json",
    buffer: Buffer.from(backup([saved])),
  });
  await expect(panel.locator("li")).toHaveCount(1);
  await expect(
    panel.getByRole("button", { name: "Save receiver", exact: true }),
  ).toBeEnabled();
  await panel.locator('input[type="file"]').setInputFiles({
    name: "bad.json",
    mimeType: "application/json",
    buffer: Buffer.from('{"schema":"future","items":[]}'),
  });
  await expect(panel.getByRole("status")).toContainText("version");
  await expect(panel.locator("li")).toHaveCount(1);
});

test("remote storage failure keeps tab entries and concurrent edits do not overwrite another tab", async ({
  page,
}) => {
  await page.addInitScript(() => {
    const get = Storage.prototype.getItem,
      set = Storage.prototype.setItem;
    Storage.prototype.getItem = function (key) {
      if (key === "browsersdr.remote-favorites.v1")
        throw new Error("storage denied");
      return get.call(this, key);
    };
    Storage.prototype.setItem = function (key, value) {
      if (key === "browsersdr.remote-favorites.v1")
        throw new Error("storage denied");
      return set.call(this, key, value);
    };
  });
  await page.goto("/?browser-test=1");
  await enter(page);
  await page.getByLabel("Receiver website", { exact: true }).fill(address);
  const panel = await overlay(page);
  await expect(panel).toContainText("Storage is unavailable");
  await panel
    .getByRole("button", { name: "Save receiver", exact: true })
    .click();
  await panel
    .getByRole("button", { name: "Save remote favorite", exact: true })
    .click();
  await expect(panel.locator("li")).toHaveCount(1);
  await expect(panel).toContainText("storage failed");
  await panel
    .getByRole("button", { name: "Close Remote favorites", exact: true })
    .click();
  await page
    .getByRole("combobox", { name: "Remote receiver type", exact: true })
    .selectOption("kiwi");
  await expect(
    page.getByRole("button", { name: /^Remote favorites/ }),
  ).toContainText("1");
});
test("remote editor preserves unfinished input and detects concurrent collection changes", async ({
  page,
}) => {
  await page.goto("/?browser-test=1");
  await page.evaluate(
    ({ key, contents }) => localStorage.setItem(key, contents),
    { key, contents: backup([saved]) },
  );
  await enter(page);
  const panel = await overlay(page);
  await panel.getByRole("button", { name: "Edit", exact: true }).click();
  await panel
    .getByLabel("Preset name", { exact: true })
    .fill("Unfinished edit");
  await panel.press("Escape");
  await overlay(page);
  await expect(panel.getByLabel("Preset name", { exact: true })).toHaveValue(
    "Unfinished edit",
  );
  await page.evaluate(
    ({ key, contents }) => {
      localStorage.setItem(key, contents);
      window.dispatchEvent(
        new StorageEvent("storage", {
          key,
          newValue: contents,
          storageArea: localStorage,
        }),
      );
    },
    { key, contents: backup([{ ...saved, name: "Other tab edit" }]) },
  );
  await panel
    .getByRole("button", { name: "Save remote favorite", exact: true })
    .click();
  await expect(panel.getByRole("status")).toContainText(
    "changed in another tab",
  );
  await expect(panel.getByLabel("Preset name", { exact: true })).toHaveValue(
    "Unfinished edit",
  );
  await panel.getByRole("button", { name: "Cancel edit", exact: true }).click();
  await expect(panel).toContainText("Other tab edit");
});
test("unsupported remote modes are rejected before audio or tuning starts", async ({
  page,
}) => {
  const wire = await fixtures(page);
  await page.goto("/?browser-test=1");
  await page.evaluate(
    ({ key, contents }) => localStorage.setItem(key, contents),
    {
      key,
      contents: backup([
        {
          ...saved,
          tune: { ...saved.tune, mode: "cw", lowCut: 300, highCut: 1100 },
        },
      ]),
    },
  );
  await enter(page);
  const panel = await overlay(page);
  await panel.getByRole("button", { name: "Load", exact: true }).click();
  await connect(page);
  await page
    .getByRole("button", { name: "Apply saved channel", exact: true })
    .click();
  await expect(page.getByRole("alert")).toContainText("saved mode");
  await expect(
    page.getByRole("button", { name: "Listen", exact: true }),
  ).toBeDisabled();
  expect(
    wire.commands.some((value) => value.includes('"action":"start"')),
  ).toBe(false);
});
test("invalid incoming remote links prevent authorized USB opening and stay recoverable", async ({
  page,
}) => {
  await page.addInitScript(() => {
    const state = window as unknown as { usbOpenCalls: number };
    state.usbOpenCalls = 0;
    Object.defineProperty(navigator, "usb", {
      configurable: true,
      value: {
        getDevices: async () => {
          return [
            {
              vendorId: 0x0bda,
              productId: 0x2838,
              productName: "Fixture RTL",
              opened: false,
              open: async () => {
                state.usbOpenCalls++;
                throw new Error("Unexpected automatic USB open");
              },
            },
          ];
        },
        addEventListener: () => {},
        removeEventListener: () => {},
      },
    });
  });
  await page.goto("/#remote=!");
  const dialog = page.getByRole("dialog", {
    name: "Shared remote preset",
    exact: true,
  });
  await expect(dialog.getByRole("alert")).toContainText("Invalid");
  await expect(
    dialog.getByRole("button", { name: "Load remote preset", exact: true }),
  ).toHaveCount(0);
  expect(
    await page.evaluate(
      () => (window as unknown as { usbOpenCalls: number }).usbOpenCalls,
    ),
  ).toBe(0);
  await dialog
    .getByRole("button", { name: "Close remote preset", exact: true })
    .click();
  await page
    .getByRole("combobox", { name: "Signal source", exact: true })
    .selectOption("synthetic");
  expect(
    await page.evaluate(
      () => (window as unknown as { usbOpenCalls: number }).usbOpenCalls,
    ),
  ).toBe(0);
  await page
    .getByRole("button", { name: "Review remote preset", exact: true })
    .click();
  await expect(dialog).toBeVisible();
});

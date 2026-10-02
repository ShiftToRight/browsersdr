import { expect, test, type Page } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { selectBladeRfImage } from "../src/radio/bladerfImages";
import ts from "typescript";
import { unzipSync } from "fflate";

async function installBladeRfUsb(
  page: Page,
  options: {
    model?: "xA4" | "xA5" | "xA9";
    firmwareMinor?: number;
    configured?: boolean;
    corruptProvider?: boolean;
  } = {},
) {
  const fixtureSource = (
    await readFile("src/testing/bladerfUsbFixture.ts", "utf8")
  )
    .replace(
      /^import .*BLADERF_READ_BYTES.*\n/,
      "const BLADERF_READ_BYTES = 65_536;\n",
    )
    .replace(/^export /gm, "");
  const fixture = ts.transpileModule(fixtureSource, {
    compilerOptions: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.None,
    },
  }).outputText;
  await page.addInitScript({
    content: `${fixture}\nwindow.__makeBladeRfUsb = () => new FakeBladeRfUsb();`,
  });
  await page.addInitScript(
    ({ model, firmwareMinor, configured, corruptProvider }) => {
      const device = (
        window as unknown as {
          __makeBladeRfUsb(): {
            opened: boolean;
            fpgaConfigured: boolean;
            model: "xA4" | "xA5" | "xA9";
            firmware: { major: number; minor: number };
            fpga: { major: number; minor: number; patch: number };
            controlOutRequests: unknown[];
            niosRequests: number[][];
            reads: unknown[];
            vendorRequests: number[];
            lifecycle: string[];
            deliverSamples(values: readonly number[]): void;
          };
        }
      ).__makeBladeRfUsb();
      device.model = model;
      device.firmware = { major: 2, minor: firmwareMinor };
      device.fpga =
        firmwareMinor === 4
          ? { major: 0, minor: 15, patch: 3 }
          : { major: 0, minor: 16, patch: 0 };
      device.fpgaConfigured = configured;
      const state = { chooserCalls: 0, gesture: false, device };
      (window as unknown as { __bladerf: typeof state }).__bladerf = state;
      const usb = {
        requestDevice: () => {
          state.chooserCalls += 1;
          state.gesture = navigator.userActivation.isActive;
          return Promise.resolve(device);
        },
      };
      Object.defineProperty(navigator, "usb", {
        configurable: true,
        value: usb,
      });
      (
        window as unknown as { __BROWSERSDR_TEST_CONFIG__: unknown }
      ).__BROWSERSDR_TEST_CONFIG__ = {
        bladerfDependencies: {
          usb,
          // Only adversarial rejection uses an injected provider. Success uses
          // configured gateware or a real imported official origin-local image.
          ...(corruptProvider
            ? {
                loadImage: async (image: { byteLength: number }) =>
                  new Uint8Array(image.byteLength),
              }
            : {}),
        },
      };
      const samples = Array.from(
        { length: 32_768 },
        (_, index) =>
          Math.round(1024 * Math.sin((2 * Math.PI * index) / 32)) || 0,
      );
      window.setInterval(() => {
        if (device.reads.length) device.deliverSamples(samples);
      }, 20);
    },
    {
      model: options.model ?? "xA4",
      firmwareMinor: options.firmwareMinor ?? 4,
      configured: options.configured ?? true,
      corruptProvider: options.corruptProvider ?? false,
    },
  );
}

for (const rate of [9_600_000, 19_200_000])
  test(`bladeRF xA4 configured production path receives native-worker SC16 at ${rate / 1_000_000} MS/s without TX`, async ({
    page,
  }) => {
    test.setTimeout(30_000);
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await installBladeRfUsb(page);
    await page.goto("/?browser-test=1");
    await page
      .getByRole("combobox", { name: "Signal source", exact: true })
      .selectOption("bladerf");
    await page.getByText("Device details & settings", { exact: true }).click();
    await expect(page.locator("div.device-setup-details")).toContainText(
      "no flash writes",
    );
    await page
      .getByRole("combobox", { name: "Mode", exact: true })
      .selectOption("AM");
    await page
      .getByLabel("Sample rate", { exact: false })
      .selectOption(String(rate));
    await page
      .getByRole("button", {
        name: "Connect",
        exact: true,
      })
      .click();
    await expect(page.locator(".receiver-status")).toContainText("connected");
    await page
      .getByRole("button", { name: "Start receiving", exact: true })
      .click();
    await expect(page.locator(".receiver-status")).toContainText(
      `native ${rate.toLocaleString("en-US")} samples/s SC16 Q11`,
    );
    await expect(page.locator(".receiver-status")).toContainText("FPGA 0.15.3");
    await expect(page.locator(".receiver-status")).toContainText(
      "preconfigured FPGA",
    );
    await page.getByLabel("Channel frequency", { exact: false }).fill("101");
    await page.getByRole("button", { name: "Tune", exact: true }).click();
    await expect(page.locator(".receiver-status")).toContainText(
      "selected 101.000000 MHz",
    );
    await page.getByRole("tab", { name: "Capture & replay" }).click();
    await expect(
      page.getByRole("button", { name: "Start I/Q recording" }),
    ).toBeEnabled();
    await expect(page.getByLabel("Recording export format")).toHaveValue(
      "sigmf",
    );
    await page
      .getByRole("button", { name: "Stop receiving", exact: true })
      .click();
    if (rate === 9_600_000) {
      const sampleRate = page.getByLabel("Sample rate", { exact: false });
      await expect(sampleRate).toBeEnabled();
      await sampleRate.selectOption("19200000");
      await page
        .getByRole("button", { name: "Start receiving", exact: true })
        .click();
      await expect(page.locator(".receiver-status")).toContainText(
        "native 19,200,000 samples/s SC16 Q11",
      );
      await page
        .getByRole("button", { name: "Stop receiving", exact: true })
        .click();
    }
    await page.getByRole("button", { name: "Disconnect", exact: true }).click();
    const state = await page.evaluate(() => {
      const current = (
        window as unknown as {
          __bladerf: {
            chooserCalls: number;
            gesture: boolean;
            device: {
              opened: boolean;
              reads: unknown[];
              vendorRequests: number[];
              lifecycle: string[];
            };
          };
        }
      ).__bladerf;
      return {
        chooserCalls: current.chooserCalls,
        gesture: current.gesture,
        opened: current.device.opened,
        reads: current.device.reads.length,
        vendorRequests: current.device.vendorRequests,
        lifecycle: current.device.lifecycle,
      };
    });
    expect(state.chooserCalls).toBe(1);
    expect(state.gesture).toBe(true);
    expect(state.opened).toBe(false);
    expect(state.reads).toBe(0);
    expect(state.vendorRequests).not.toContain(5);
    expect(state.lifecycle).not.toContain("fpga:begin");
    expect(
      state.lifecycle.some((entry) => entry.startsWith("fpga:write:")),
    ).toBe(false);
    const starts = state.lifecycle.filter((entry) => entry === "rx:on").length;
    const stops = state.lifecycle.filter((entry) => entry === "rx:off").length;
    expect(starts).toBe(rate === 9_600_000 ? 2 : 1);
    // Disconnect performs one final defensive RX-disable after an explicit stop.
    expect(stops).toBeGreaterThanOrEqual(starts);
    expect(errors).toEqual([]);
  });

test("bladeRF applies manual gain and switches physical RX inputs on one connection", async ({
  page,
}) => {
  await installBladeRfUsb(page);
  await page.goto("/?browser-test=1");
  await page
    .getByRole("combobox", { name: "Signal source", exact: true })
    .selectOption("bladerf");
  await page.getByText("Device details & settings", { exact: true }).click();
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  const accepted = page.getByLabel("Accepted bladeRF RX settings");
  await expect(accepted).toContainText("RX1");
  await page
    .getByLabel("bladeRF gain mode", { exact: true })
    .selectOption("manual");
  await page.getByLabel("bladeRF manual gain", { exact: true }).fill("20");
  await page
    .getByRole("button", { name: "Apply bladeRF RX settings", exact: true })
    .click();
  await expect(accepted).toContainText("20 dB readback");
  await page
    .getByRole("button", { name: "Start receiving", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "Stop receiving", exact: true }),
  ).toBeEnabled();
  for (const rxInput of ["RX2", "RX1"]) {
    await page
      .getByLabel("bladeRF receive input", { exact: true })
      .selectOption(rxInput);
    await page
      .getByRole("button", { name: "Apply bladeRF RX settings", exact: true })
      .click();
    await expect(accepted).toContainText(rxInput);
    await expect(page.locator(".receiver-status")).toContainText(
      "Receiving WBFM",
    );
    const enabled = await page.evaluate(() => {
      const s = (
        window as unknown as {
          __bladerf: {
            chooserCalls: number;
            device: { rfic: Map<number, bigint>; vendorRequests: number[] };
          };
        }
      ).__bladerf;
      return {
        rx1: Number(s.device.rfic.get(2)),
        rx2: Number(s.device.rfic.get(0x202)),
        chooser: s.chooserCalls,
        tx: s.device.vendorRequests.includes(5),
      };
    });
    expect(enabled).toEqual({
      rx1: rxInput === "RX1" ? 1 : 0,
      rx2: rxInput === "RX2" ? 1 : 0,
      chooser: 1,
      tx: false,
    });
  }
  for (const mode of ["fast-attack-agc", "hybrid-agc", "slow-attack-agc"]) {
    await page
      .getByLabel("bladeRF gain mode", { exact: true })
      .selectOption(mode);
    await page
      .getByRole("button", { name: "Apply bladeRF RX settings", exact: true })
      .click();
    await expect(accepted).toContainText("gain varies automatically");
    await expect(
      page.getByRole("button", {
        name: "Apply bladeRF RX settings",
        exact: true,
      }),
    ).toBeEnabled();
  }
  await page.getByRole("button", { name: "Disconnect", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Connect", exact: true }),
  ).toBeEnabled();
});

async function selectBladeRf(page: Page) {
  await page.goto("/?browser-test=1");
  await page
    .getByRole("combobox", { name: "Signal source", exact: true })
    .selectOption("bladerf");
  await page.getByText("Device details & settings", { exact: true }).click();
}
async function trace(page: Page) {
  return page.evaluate(() => {
    const state = (
      window as unknown as {
        __bladerf: {
          device: {
            opened: boolean;
            vendorRequests: number[];
            controlOutRequests: unknown[];
            niosRequests: number[][];
            lifecycle: string[];
          };
        };
      }
    ).__bladerf;
    return {
      opened: state.device.opened,
      requests: state.device.vendorRequests,
      controlOut: state.device.controlOutRequests,
      nios: state.device.niosRequests.map((packet) => Array.from(packet)),
      lifecycle: state.device.lifecycle,
    };
  });
}
function noForbiddenWrites(state: Awaited<ReturnType<typeof trace>>) {
  expect(state.controlOut).toEqual([]);
  expect(
    state.requests.every((request) =>
      [0, 1, 2, 4, 6, 7, 110].includes(request),
    ),
  ).toBe(true);
  expect(state.lifecycle).not.toContain("alternate:2");
  expect(
    state.nios
      .filter((packet) => packet[0] === 0x45 && packet[2]! & 1)
      .every((packet) => [0, 2, 15].includes(packet[5]!)),
  ).toBe(true);
}

for (const model of ["xA4", "xA5", "xA9"] as const) {
  for (const firmwareMinor of [4, 5, 6]) {
    test(`configured ${model} firmware 2.${firmwareMinor} reports model/provenance and receives/stops`, async ({
      page,
    }) => {
      await installBladeRfUsb(page, { model, firmwareMinor });
      await selectBladeRf(page);
      await page.getByRole("button", { name: "Connect", exact: true }).click();
      const status = page.locator(".receiver-status");
      await expect(status).toContainText(model);
      await expect(status).toContainText("preconfigured FPGA");
      if (model !== "xA4") await expect(status).toContainText(/experimental/i);
      await page
        .getByRole("button", { name: "Start receiving", exact: true })
        .click();
      await expect(status).toContainText("SC16 Q11");
      await page
        .getByRole("button", { name: "Stop receiving", exact: true })
        .click();
      await page
        .getByRole("button", { name: "Disconnect", exact: true })
        .click();
      const state = await trace(page);
      expect(state.opened).toBe(false);
      expect(state.requests).not.toContain(2);
      noForbiddenWrites(state);
    });
  }
  test(`native Q11 recording exports exact samples for ${model}`, async ({
    page,
  }) => {
    await installBladeRfUsb(page, { model, firmwareMinor: 5 });
    await selectBladeRf(page);
    await page.getByRole("button", { name: "Connect", exact: true }).click();
    await page
      .getByRole("button", { name: "Start receiving", exact: true })
      .click();
    await page.getByRole("tab", { name: "Capture & replay" }).click();
    await expect(page.getByLabel("Recording export format")).toHaveValue(
      "sigmf",
    );
    await page
      .getByRole("button", { name: "Start I/Q recording", exact: true })
      .click();
    await expect(page.locator(".recording-state")).toContainText(
      /(?:0\.[1-9]\d|[1-9]\d*\.\d{2}) \/ (?:32|2048) MiB/,
    );
    await page
      .getByRole("button", { name: "Stop recording", exact: true })
      .click();
    await expect(
      page.getByRole("button", { name: "Download ZIP", exact: true }),
    ).toBeEnabled();
    const download = page.waitForEvent("download");
    await page
      .getByRole("button", { name: "Download ZIP", exact: true })
      .click();
    const entries = unzipSync(await readFile((await (await download).path())!));
    const data = Object.entries(entries).find(([name]) =>
      name.endsWith(".sigmf-data"),
    )![1];
    const metadata = JSON.parse(
      new TextDecoder().decode(
        Object.entries(entries).find(([name]) =>
          name.endsWith(".sigmf-meta"),
        )![1],
      ),
    );
    expect(metadata.global["core:datatype"]).toBe("ci16_le");
    expect(metadata.global["core:hw"]).toContain(model);
    expect(data.byteLength).toBeGreaterThan(0);
    expect(data.byteLength % 4).toBe(0);
    const words = new DataView(data.buffer, data.byteOffset, data.byteLength);
    for (let index = 0; index < 256; index++) {
      expect(words.getInt16(index * 2, true)).toBe(
        Math.round(1024 * Math.sin((2 * Math.PI * index) / 32)) || 0,
      );
    }
    await page
      .getByRole("button", { name: "Stop receiving", exact: true })
      .click();
    await page.getByRole("button", { name: "Disconnect", exact: true }).click();
    await page
      .getByRole("tab", { name: "Open recording", exact: true })
      .click();
    await page.getByLabel("Replay pair format").selectOption("sigmf");
    await page.getByLabel("SigMF replay mode").selectOption("AM");
    await page
      .locator('#open-recording-panel input[type="file"]')
      .nth(0)
      .setInputFiles({
        name: "capture.sigmf-data",
        mimeType: "application/octet-stream",
        buffer: Buffer.from(data),
      });
    await page
      .locator('#open-recording-panel input[type="file"]')
      .nth(1)
      .setInputFiles({
        name: "capture.sigmf-meta",
        mimeType: "application/json",
        buffer: Buffer.from(JSON.stringify(metadata)),
      });
    await page
      .getByRole("button", { name: "Load SigMF pair", exact: true })
      .click();
    await expect(page.getByText(/Loaded SigMF replay:/)).toBeVisible();
    await expect(
      page.getByRole("combobox", { name: "Signal source", exact: true }),
    ).toHaveValue("replay");
    noForbiddenWrites(await trace(page));
  });
  test(`empty ${model} gives model-specific import guidance without changing USB alternates`, async ({
    page,
  }) => {
    await installBladeRfUsb(page, {
      model,
      firmwareMinor: 5,
      configured: false,
    });
    await selectBladeRf(page);
    await page.getByRole("button", { name: "Connect", exact: true }).click();
    await expect(page.locator(".receiver-status")).toContainText(
      `hosted${model} 0.16.0`,
    );
    await expect(page.locator(".receiver-status")).toContainText(/import/i);
    const state = await trace(page);
    expect(state.requests).not.toContain(2);
    expect(state.nios).toEqual([]);
    expect(
      state.lifecycle.some((event) => event.startsWith("alternate:")),
    ).toBe(false);
    noForbiddenWrites(state);
  });
}

test("custom provider cannot program same-length synthetic bytes through browser fixture", async ({
  page,
}) => {
  await installBladeRfUsb(page, { configured: false, corruptProvider: true });
  await selectBladeRf(page);
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  await expect(page.locator(".receiver-status")).toContainText(
    "SHA-256 mismatch",
  );
  const state = await trace(page);
  expect(state.requests).not.toContain(2);
  expect(state.nios).toEqual([]);
  expect(state.lifecycle.some((event) => event.startsWith("alternate:"))).toBe(
    false,
  );
  noForbiddenWrites(state);
});

// Ephemeral opt-in actual artifact imports exercise native IndexedDB and final
// SHA-256; RBF files are never checked in and no USB hardware is accessed.
for (const model of ["xA4", "xA5", "xA9"] as const) {
  for (const firmwareMinor of [4, 5]) {
    test(`official stored ${model} firmware 2.${firmwareMinor} imports, survives reload, and loads verified bytes`, async ({
      page,
    }) => {
      test.skip(
        !process.env.BLADERF_OFFICIAL_ARTIFACT_DIR,
        "Requires ephemeral official RBF artifacts",
      );
      const image = selectBladeRfImage(model, {
        major: 2,
        minor: firmwareMinor,
      });
      await installBladeRfUsb(page, {
        model,
        firmwareMinor,
        configured: false,
      });
      await selectBladeRf(page);
      await page
        .getByLabel("Import fpga image", { exact: true })
        .setInputFiles(
          `${process.env.BLADERF_OFFICIAL_ARTIFACT_DIR}/${image.filename}`,
        );
      await expect(page.locator("div.device-setup-details")).toContainText(
        `Verified and saved official hosted${model} v${image.version}`,
      );
      await page.reload();
      await page
        .getByText("Device details & settings", { exact: true })
        .click();
      await expect(page.locator("div.device-setup-details")).toContainText(
        `hosted${model} v${image.version}`,
      );
      await page.getByRole("button", { name: "Connect", exact: true }).click();
      await expect(page.locator(".receiver-status")).toContainText(
        `volatile hosted${model} v${image.version}`,
      );
      await page
        .getByRole("button", { name: "Start receiving", exact: true })
        .click();
      await expect(page.locator(".receiver-status")).toContainText("SC16 Q11");
      await page
        .getByRole("button", { name: "Stop receiving", exact: true })
        .click();
      await page
        .getByRole("button", { name: "Disconnect", exact: true })
        .click();
      const state = await trace(page);
      expect(state.requests.filter((request) => request === 2)).toHaveLength(1);
      expect(
        state.lifecycle.filter((event) => event.startsWith("fpga:write:")),
      ).toEqual([`fpga:write:${image.byteLength}`]);
      noForbiddenWrites(state);
    });
  }
}

test("corrupt origin-local stored image rejects before programming with native SHA-256", async ({
  page,
}) => {
  test.skip(
    !process.env.BLADERF_OFFICIAL_ARTIFACT_DIR,
    "Requires ephemeral official RBF artifact",
  );
  const image = selectBladeRfImage("xA4", { major: 2, minor: 4 });
  await installBladeRfUsb(page, { configured: false });
  await selectBladeRf(page);
  await page
    .getByLabel("Import fpga image", { exact: true })
    .setInputFiles(
      `${process.env.BLADERF_OFFICIAL_ARTIFACT_DIR}/${image.filename}`,
    );
  await expect(page.locator("div.device-setup-details")).toContainText(
    "Verified and saved official hostedxA4 v0.15.3",
  );
  await page.evaluate(async (sha256) => {
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open("browsersdr-bladerf-images", 1);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    try {
      await new Promise<void>((resolve, reject) => {
        const transaction = database.transaction(
          "verified-images",
          "readwrite",
        );
        const store = transaction.objectStore("verified-images");
        const request = store.get(sha256);
        request.onsuccess = () => {
          const row = request.result as {
            sha256: string;
            bytes: ArrayBuffer;
            storedAt: number;
          };
          new Uint8Array(row.bytes)[row.bytes.byteLength - 1]! ^= 1;
          store.put(row);
        };
        transaction.oncomplete = () => resolve();
        transaction.onerror = () => reject(transaction.error);
      });
    } finally {
      database.close();
    }
  }, image.sha256);
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  await expect(page.locator(".receiver-status")).toContainText(
    "saved hostedxA4 0.15.3 image failed verification",
  );
  const state = await trace(page);
  expect(state.requests).not.toContain(2);
  expect(state.nios).toEqual([]);
  expect(state.lifecycle.some((event) => event.startsWith("alternate:"))).toBe(
    false,
  );
  noForbiddenWrites(state);
});

import { expect, test, type Page } from "@playwright/test";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

const pageErrors = new WeakMap<Page, Error[]>();

test.beforeEach(async ({ page }) => {
  const errors: Error[] = [];
  pageErrors.set(page, errors);
  page.on("pageerror", (error) => errors.push(error));
});

test.afterEach(async ({ page }) => {
  expect(pageErrors.get(page) ?? []).toEqual([]);
});

async function gotoApp(page: Page): Promise<void> {
  await page.goto("/?browser-test=1");
  await expect(page.getByLabel("Live signal path")).toBeVisible();
}

async function selectSyntheticAndStart(page: Page): Promise<void> {
  await page
    .locator('select[aria-label="Signal source"]')
    .selectOption("synthetic");
  await page.getByRole("button", { name: "Start demo" }).click();
  await expect(page.locator(".receiver-status")).toContainText(
    "Synthetic RF demo running",
  );
}

async function installWorkerInstrumentation(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const NativeWorker = window.Worker;
    const state = { created: 0, terminated: 0, active: 0 };
    class InstrumentedWorker extends NativeWorker {
      private counted = true;
      constructor(scriptURL: string | URL, options?: WorkerOptions) {
        super(scriptURL, options);
        state.created += 1;
        state.active += 1;
      }
      override terminate(): void {
        if (this.counted) {
          this.counted = false;
          state.terminated += 1;
          state.active -= 1;
        }
        super.terminate();
      }
    }
    Object.defineProperty(window, "Worker", {
      configurable: true,
      value: InstrumentedWorker,
    });
    (
      window as Window & { __workerLifecycle?: typeof state }
    ).__workerLifecycle = state;
  });
}

function highRateReplayFiles() {
  const sampleRateHz = 2_400_000;
  const sampleCount = 400_000;
  const metadata = {
    format: "browsersdr-cu8-v1",
    sampleEncoding: "unsigned-8-bit",
    sampleOrder: "interleaved-iq",
    bytesPerComplexSample: 2,
    normalization: "float = byte / 128 - 0.995",
    sampleRateHz,
    centerFrequencyHz: 200_000_000,
    selectedChannelFrequencyHz: 200_000_000,
    captureStartedAt: "2026-09-24T00:00:00.000Z",
    sampleCount,
    durationSeconds: sampleCount / sampleRateHz,
    source: "synthetic",
    mode: "WBFM",
    channelBandwidthHz: 150_000,
    squelch: 0,
    gainDb: null,
    knownGaps: [
      {
        afterSample: 200_000,
        missingSamples: 24_000_000,
        reason: "Deterministic test pause",
      },
    ],
    stopReason: "user",
    provenance:
      "Playwright deterministic high-rate replay fixture; no hardware capture.",
  };
  return {
    data: {
      name: "high-rate.cu8",
      mimeType: "application/octet-stream",
      buffer: Buffer.alloc(sampleCount * 2, 128),
    },
    metadata: {
      name: "high-rate.json",
      mimeType: "application/json",
      buffer: Buffer.from(JSON.stringify(metadata)),
    },
  };
}

function sigmfReplayFiles() {
  const sampleRateHz = 48_000;
  // Keep the running state observable even under the slower development
  // StrictMode lifecycle while retaining a short, bounded replay.
  const sampleCount = 96_000;
  const data = Buffer.alloc(sampleCount * 2, 128);
  const metadata = {
    global: {
      "core:datatype": "cu8",
      "core:version": "1.2.6",
      "core:sample_rate": sampleRateHz,
      "core:sha512": createHash("sha512").update(data).digest("hex"),
      "core:description":
        "The annotation below is deliberately untrusted by the importer.",
    },
    captures: [
      {
        "core:sample_start": 0,
        "core:global_index": 0,
        "core:frequency": 10_000_000,
        "core:datetime": "2026-09-24T00:00:00.000Z",
      },
      {
        "core:sample_start": 12_000,
        "core:global_index": 16_800,
        "core:frequency": 10_000_000,
      },
    ],
    annotations: [
      {
        "core:sample_start": 0,
        "core:label": "DAB",
        "core:comment": "Do not use this as a mode.",
      },
    ],
  };
  return {
    data: {
      name: "paced.sigmf-data",
      mimeType: "application/octet-stream",
      buffer: data,
    },
    metadata: {
      name: "paced.sigmf-meta",
      mimeType: "application/json",
      buffer: Buffer.from(JSON.stringify(metadata)),
    },
  };
}

type ZipEntry = { name: string; data: Uint8Array };

function readStoredZip(archive: Uint8Array): ZipEntry[] {
  const view = new DataView(
    archive.buffer,
    archive.byteOffset,
    archive.byteLength,
  );
  const files: ZipEntry[] = [];
  let offset = 0;
  while (
    offset + 30 <= archive.byteLength &&
    view.getUint32(offset, true) === 0x04034b50
  ) {
    expect(view.getUint16(offset + 8, true)).toBe(0);
    const size = view.getUint32(offset + 18, true);
    const nameLength = view.getUint16(offset + 26, true);
    const extraLength = view.getUint16(offset + 28, true);
    const nameStart = offset + 30;
    const dataStart = nameStart + nameLength + extraLength;
    files.push({
      name: new TextDecoder().decode(
        archive.subarray(nameStart, nameStart + nameLength),
      ),
      data: archive.slice(dataStart, dataStart + size),
    });
    offset = dataStart + size;
  }
  return files;
}

async function installRtlAdapter(
  page: Page,
  mode: "normal" | "pending-connect" | "close-fails-once",
): Promise<void> {
  await page.addInitScript((adapterMode) => {
    const state: {
      providerGets: number;
      closeAttempts: number;
      audioCloseAttempts: number;
      resolveConnect?: () => void;
    } = { providerGets: 0, closeAttempts: 0, audioCloseAttempts: 0 };
    (window as Window & { __rtlTestState?: typeof state }).__rtlTestState =
      state;
    Object.defineProperty(navigator, "usb", { configurable: true, value: {} });

    const createSource = () => ({
      setSampleRate: async (rate: number) => rate,
      setCenterFrequency: async (frequency: number) => frequency,
      setParameter: async <V>(_parameter: string, value: V) => value,
      startReceiving: async () => undefined,
      readSamples: () => new Promise<never>(() => undefined),
      close: async () => {
        state.closeAttempts += 1;
        if (adapterMode === "close-fails-once" && state.closeAttempts === 1)
          throw new Error("Injected USB close failure");
      },
    });

    const createAudioContext = () => {
      let audioState = "suspended";
      return {
        get state() {
          return audioState;
        },
        sampleRate: 48_000,
        currentTime: 0,
        destination: {},
        addEventListener: () => undefined,
        removeEventListener: () => undefined,
        resume: async () => {
          audioState = "running";
        },
        suspend: async () => {
          audioState = "suspended";
        },
        close: async () => {
          state.audioCloseAttempts += 1;
          audioState = "closed";
        },
      };
    };

    (
      window as Window & { __BROWSERSDR_TEST_CONFIG__?: unknown }
    ).__BROWSERSDR_TEST_CONFIG__ = {
      rtlDependencies: {
        createAudioContext,
        createSourceProvider: (permissionGranted: () => void) => ({
          get: async () => {
            state.providerGets += 1;
            if (adapterMode === "pending-connect") {
              await new Promise<void>((resolve) => {
                state.resolveConnect = resolve;
              });
            }
            permissionGranted();
            return createSource();
          },
        }),
      },
    };
  }, mode);
}

test("synthetic processing survives StrictMode, stop/restart, source switch, and unmount", async ({
  page,
}, testInfo) => {
  await installWorkerInstrumentation(page);
  await gotoApp(page);

  await selectSyntheticAndStart(page);
  await page.getByRole("tab", { name: /Diagnostics/ }).click();
  const analysisBlocks = page
    .getByText("Analysis blocks", { exact: true })
    .locator("xpath=following-sibling::dd");
  await expect
    .poll(async () =>
      Number((await analysisBlocks.textContent())?.replaceAll(",", "") ?? 0),
    )
    .toBeGreaterThan(0);

  const workerState = () =>
    page.evaluate(
      () =>
        (
          window as Window & {
            __workerLifecycle?: { created: number; active: number };
          }
        ).__workerLifecycle,
    );
  await expect.poll(async () => (await workerState())?.active).toBe(1);
  if (testInfo.project.name === "chromium-dev") {
    await expect
      .poll(async () => (await workerState())?.created)
      .toBeGreaterThanOrEqual(2);
  }

  await page.getByRole("tab", { name: /Receiver/ }).click();
  await page.getByRole("button", { name: "Stop", exact: true }).click();
  await expect(page.locator(".receiver-status")).toContainText(
    "Receiver stopped",
  );
  await page.getByRole("button", { name: "Start demo" }).click();
  await expect(page.locator(".receiver-status")).toContainText(
    "Synthetic RF demo running",
  );
  await page
    .locator('select[aria-label="Signal source"]')
    .selectOption("replay");
  await expect(page.locator('select[aria-label="Signal source"]')).toHaveValue(
    "replay",
  );
  await expect(page.locator(".receiver-status")).toContainText(
    "Receiver disconnected",
  );

  await page.evaluate(() =>
    (
      window as Window & { __BROWSERSDR_TEST_RUNTIME__?: { unmount(): void } }
    ).__BROWSERSDR_TEST_RUNTIME__?.unmount(),
  );
  await expect(page.locator("#root")).toBeEmpty();
  await expect.poll(async () => (await workerState())?.active).toBe(0);
});

test("replay routes supported analog and digital mode transitions at 2.4 MS/s", async ({
  page,
}) => {
  await gotoApp(page);
  await page
    .locator('select[aria-label="Signal source"]')
    .selectOption("replay");
  await page.getByRole("tab", { name: "Capture & replay" }).click();
  const fixture = highRateReplayFiles();
  const fileInputs = page.locator(".file-picker-input");
  await fileInputs.nth(0).setInputFiles(fixture.data);
  await fileInputs.nth(1).setInputFiles(fixture.metadata);
  await page.getByRole("button", { name: "Load files" }).click();
  await expect(page.locator(".file-message")).toContainText(
    "Loaded 400,000 samples",
  );
  await page.getByRole("button", { name: "Start replay" }).click();
  await expect(page.locator(".receiver-status")).toContainText(
    "effective rate 2,400,000 samples/s",
  );

  for (const mode of ["AIS", "DAB", "ADS-B", "SRD", "AM"] as const) {
    await page.getByLabel("Mode").selectOption(mode);
    await expect(page.locator(".receiver-status")).toContainText(`· ${mode} ·`);
    if (mode === "SRD") {
      await expect(
        page.locator("label", { hasText: /^\s*Modulation/ }).locator("select"),
      ).toHaveValue("ook");
      await expect(
        page.locator("label", { hasText: /^\s*Decoder/ }).locator("select"),
      ).toHaveValue("none");
      await page.getByRole("tab", { name: "Audio & decode" }).click();
      await expect(
        page.getByRole("heading", { name: "Short-range devices" }),
      ).toBeVisible();
      await expect(
        page.getByText("Unknown signals remain inspector-only."),
      ).toBeVisible();
      const download = page.waitForEvent("download");
      await page
        .getByRole("button", { name: "Export bounded SRD JSON" })
        .click();
      expect((await download).suggestedFilename()).toContain("srd");
    }
    if (mode === "AM") {
      await page.getByRole("tab", { name: "Receiver" }).click();
      await expect(
        page.getByRole("meter", { name: "Current channel quality" }),
      ).toBeVisible();
      await expect(
        page.getByRole("button", { name: "Auto set" }),
      ).toBeEnabled();
    }
  }
  await page.getByRole("tab", { name: "Audio & decode" }).click();
  await expect(
    page.getByRole("heading", { name: "Radio Data System" }),
  ).toBeVisible();
});

test("imports a bounded SigMF pair into paced replay without requesting USB", async ({
  page,
}) => {
  await page.addInitScript(() => {
    const state = { requests: 0 };
    Object.defineProperty(navigator, "usb", {
      configurable: true,
      value: {
        requestDevice: async () => {
          state.requests += 1;
          throw new Error("USB must not be requested by replay");
        },
      },
    });
    (window as Window & { __sigmfUsbState?: typeof state }).__sigmfUsbState =
      state;
  });
  await gotoApp(page);
  await page
    .locator('select[aria-label="Signal source"]')
    .selectOption("replay");
  await page.getByRole("tab", { name: "Capture & replay" }).click();
  await page.getByLabel("Replay pair format").selectOption("sigmf");
  await page.getByLabel("SigMF replay mode").selectOption("AM");
  await expect(page.getByLabel("SigMF replay channel")).toHaveValue("center");
  const fixture = sigmfReplayFiles();
  const fileInputs = page.locator(".file-picker-input");
  await fileInputs.nth(0).setInputFiles(fixture.data);
  await fileInputs.nth(1).setInputFiles(fixture.metadata);
  await page.getByRole("button", { name: "Load SigMF pair" }).click();
  await expect(page.locator(".file-message")).toContainText(
    "Loaded SigMF replay: 96,000 samples",
  );

  await page.getByRole("button", { name: "Start replay" }).click();
  await expect(page.locator(".receiver-status")).toContainText(
    "Replaying AM capture",
  );
  await page.getByRole("button", { name: "Stop", exact: true }).click();
  await expect(page.locator(".receiver-status")).toContainText(
    "Receiver stopped",
  );
  await page.getByRole("button", { name: "Start replay" }).click();
  await expect(page.locator(".receiver-status")).toContainText(
    "Replay reached end of file",
    { timeout: 5_000 },
  );
  expect(
    await page.evaluate(
      () =>
        (window as Window & { __sigmfUsbState?: { requests: number } })
          .__sigmfUsbState?.requests,
    ),
  ).toBe(0);
});

test("survey measurements progress without animation callbacks and freeze provenance", async ({
  page,
}) => {
  await page.addInitScript(() => {
    let identifier = 0;
    window.requestAnimationFrame = () => ++identifier;
    window.cancelAnimationFrame = () => undefined;
  });
  await gotoApp(page);
  await selectSyntheticAndStart(page);
  await page.getByRole("tab", { name: /Explorer/ }).click();

  await page
    .getByRole("textbox", { name: "Profile name" })
    .fill("Acquisition profile");
  await page
    .getByRole("textbox", { name: "Site label" })
    .fill("Acquisition site");
  await page.getByRole("spinbutton", { name: /Start frequency/ }).fill("99.9");
  await page.getByRole("spinbutton", { name: /End frequency/ }).fill("100.1");
  const surveySliders = page.locator('.explorer-controls input[type="range"]');
  await surveySliders.nth(0).fill("150");
  await surveySliders.nth(1).fill("1");
  await page.getByRole("button", { name: "Scan current window" }).click();

  await expect(
    page.locator(".explorer-results .diagnostic-message"),
  ).toContainText("Survey complete");
  await expect(
    page.getByRole("progressbar", { name: "Spectrum scan progress" }),
  ).toHaveAttribute("value", "2");
  await page
    .getByRole("textbox", { name: "Profile name" })
    .fill("Edited later");
  await page.getByRole("textbox", { name: "Site label" }).fill("Edited site");
  const downloadPromise = page.waitForEvent("download");
  await page.getByRole("button", { name: "Manifest JSON" }).click();
  const download = await downloadPromise;
  const manifest = JSON.parse(
    (await readFile(await download.path())).toString(),
  ) as {
    status: string;
    profile: {
      name: string;
      site: { label: string };
      bands: Array<{
        startFrequencyHz: number;
        endFrequencyHz: number;
        dwellMs: number;
        thresholdDb: number;
      }>;
    };
  };
  expect(manifest.status).toBe("completed");
  expect(manifest.profile.name).toBe("Acquisition profile");
  expect(manifest.profile.site.label).toBe("Acquisition site");
  expect(manifest.profile.bands[0]).toMatchObject({
    startFrequencyHz: 99_590_400,
    endFrequencyHz: 100_409_600,
    dwellMs: 150,
    thresholdDb: 1,
  });

  const firstMarker = page.locator(".candidate-marker").first();
  const firstCard = page.locator(".candidate-review-card").first();
  await expect(firstMarker).toBeVisible();
  await firstMarker.click();
  await expect(firstCard).toHaveClass(/candidate-review-card-highlighted/);
  await firstCard
    .getByRole("textbox", { name: "Label" })
    .fill("Persistent carrier");
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          new Promise<string | undefined>((resolve, reject) => {
            const open = indexedDB.open("browsersdr-surveys", 1);
            open.onerror = () => reject(open.error);
            open.onsuccess = () => {
              const request = open.result
                .transaction("survey-runs", "readonly")
                .objectStore("survey-runs")
                .get("latest");
              request.onerror = () => reject(request.error);
              request.onsuccess = () => {
                resolve(request.result?.records?.[0]?.annotation?.label);
                open.result.close();
              };
            };
          }),
      ),
    )
    .toBe("Persistent carrier");

  await page.reload();
  await page.getByRole("tab", { name: /Explorer/ }).click();
  await expect(
    page.locator(".explorer-results .diagnostic-message"),
  ).toContainText("Restored");
  await expect(
    page.locator(".candidate-review-card").first().getByRole("textbox", {
      name: "Label",
    }),
  ).toHaveValue("Persistent carrier");
});

test("survey cancellation preserves progress and restores controls", async ({
  page,
}) => {
  await gotoApp(page);
  await selectSyntheticAndStart(page);
  await page.getByRole("tab", { name: /Explorer/ }).click();
  await page.getByLabel("Scan scope").selectOption("band-plan");
  await page.getByRole("spinbutton", { name: /Start frequency/ }).fill("98");
  await page.getByRole("spinbutton", { name: /End frequency/ }).fill("102");
  await page
    .locator('.explorer-controls input[type="range"]')
    .nth(0)
    .fill("150");
  await page.getByRole("button", { name: "Save band" }).click();
  await page.getByRole("button", { name: "Run band plan" }).click();
  const progress = page.getByRole("progressbar", {
    name: "Spectrum scan progress",
  });
  await expect
    .poll(async () => Number(await progress.getAttribute("value")))
    .toBeGreaterThan(0);
  await page.getByRole("button", { name: "Pause scan" }).click();
  await expect(
    page.locator(".explorer-results .diagnostic-message"),
  ).toContainText("Survey paused");
  await expect
    .poll(async () => Number(await progress.getAttribute("value")))
    .toBeGreaterThan(0);
  await expect(
    page.getByRole("button", { name: "Run band plan" }),
  ).toBeEnabled();
  await expect(
    page.getByRole("textbox", { name: "Profile name" }),
  ).toBeEnabled();
  await page.getByRole("tab", { name: /Receiver/ }).click();
  await expect(page.locator(".receiver-status")).toContainText(
    "Synthetic RF demo running",
  );
});

test("recording preparation retries and the paired archive remains truthfully downloadable", async ({
  page,
}) => {
  await page.addInitScript(() => {
    const NativeWorker = window.Worker;
    window.Worker = class extends NativeWorker {
      override postMessage(
        message: unknown,
        transfer: Transferable[] | StructuredSerializeOptions = [],
      ) {
        const testWindow = window as Window & {
          __failNextPreparation?: boolean;
        };
        if (
          (message as { type?: string })?.type === "prepare" &&
          testWindow.__failNextPreparation
        ) {
          testWindow.__failNextPreparation = false;
          queueMicrotask(() =>
            this.dispatchEvent(
              new MessageEvent("message", {
                data: {
                  ok: false,
                  error: "Injected worker preparation failure",
                },
              }),
            ),
          );
          return;
        }
        if (Array.isArray(transfer)) super.postMessage(message, transfer);
        else super.postMessage(message, transfer);
      }
    };
    // Successful retry must hash inside the worker, not on the UI thread.
    Object.defineProperty(SubtleCrypto.prototype, "digest", {
      configurable: true,
      value: () => Promise.reject(new Error("Unexpected main-thread hashing")),
    });
  });
  await gotoApp(page);
  await selectSyntheticAndStart(page);
  await page.getByRole("tab", { name: "Capture & replay" }).click();
  await page.getByLabel("Recording export format").selectOption("sigmf");
  await page.getByRole("button", { name: "Start I/Q recording" }).click();
  const recordingControls = page.locator(".recording-controls");
  await expect
    .poll(async () => {
      const text = await recordingControls.textContent();
      const match = text?.match(/([0-9.]+) \/ 32 MiB/);
      return Number(match?.[1] ?? 0);
    })
    .toBeGreaterThan(0);
  await page.evaluate(() => {
    (
      window as Window & { __failNextPreparation?: boolean }
    ).__failNextPreparation = true;
  });
  await page.getByRole("button", { name: "Stop & prepare" }).click();
  await expect(page.locator(".file-message")).toContainText(
    "Injected worker preparation failure",
  );
  await expect(
    page.getByRole("button", { name: "Retry preparation" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Retry preparation" }).click();
  await expect(page.locator(".file-message")).toContainText("Prepared");

  const firstDownload = page.waitForEvent("download");
  await page.getByRole("button", { name: "Download paired ZIP" }).click();
  const archiveDownload = await firstDownload;
  const archive = new Uint8Array(await readFile(await archiveDownload.path()));
  const entries = readStoredZip(archive);
  expect(entries).toHaveLength(2);
  expect(entries.map((entry) => entry.name)).toEqual([
    expect.stringMatching(/\.sigmf-data$/),
    expect.stringMatching(/\.sigmf-meta$/),
  ]);
  expect(entries[0]!.name.replace(/\.sigmf-data$/, "")).toBe(
    entries[1]!.name.replace(/\.sigmf-meta$/, ""),
  );
  expect(entries[0]!.data.byteLength).toBeGreaterThan(0);
  const metadata = JSON.parse(new TextDecoder().decode(entries[1]!.data)) as {
    global: Record<string, unknown>;
  };
  expect(metadata.global).toMatchObject({
    "core:datatype": "cu8",
    "core:version": "1.2.6",
  });
  expect(metadata.global["core:sha512"]).toMatch(/^[a-f0-9]{128}$/);
  expect(metadata.global["core:sha512"]).toBe(
    createHash("sha512").update(entries[0]!.data).digest("hex"),
  );
  await expect(page.locator(".file-message")).toContainText(
    "do not confirm that the file was stored",
  );
  await expect(page.locator(".capture-panel .display-note")).toContainText(
    "State: download requested",
  );

  const repeatedDownload = page.waitForEvent("download");
  await page.getByRole("button", { name: "Download paired ZIP" }).click();
  await repeatedDownload;
  await expect(
    page.getByRole("button", { name: "Download paired ZIP" }),
  ).toBeEnabled();
});

test("pending permission is cancelled on unmount and late ownership is released", async ({
  page,
}) => {
  await installRtlAdapter(page, "pending-connect");
  await gotoApp(page);
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  await expect(page.locator(".receiver-status")).toContainText(
    "Choose an RTL-SDR device",
  );
  await page.evaluate(() =>
    (
      window as Window & { __BROWSERSDR_TEST_RUNTIME__?: { unmount(): void } }
    ).__BROWSERSDR_TEST_RUNTIME__?.unmount(),
  );
  await expect(page.locator("#root")).toBeEmpty();
  await page.evaluate(() =>
    (
      window as Window & { __rtlTestState?: { resolveConnect?: () => void } }
    ).__rtlTestState?.resolveConnect?.(),
  );
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (window as Window & { __rtlTestState?: { closeAttempts: number } })
            .__rtlTestState?.closeAttempts,
      ),
    )
    .toBe(1);
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (
            window as Window & {
              __rtlTestState?: { audioCloseAttempts: number };
            }
          ).__rtlTestState?.audioCloseAttempts,
      ),
    )
    .toBe(1);
});

test("failed device close retains the single owner until retry succeeds", async ({
  page,
}) => {
  await installRtlAdapter(page, "close-fails-once");
  await gotoApp(page);
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  await expect(page.locator(".receiver-status")).toContainText(
    "RTL-SDR connected",
  );
  await page.getByRole("button", { name: "Disconnect", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText(
    "Injected USB close failure",
  );
  await expect(
    page.getByRole("button", { name: "Connect", exact: true }),
  ).toBeDisabled();
  await expect(
    page.getByRole("button", { name: "Disconnect", exact: true }),
  ).toBeEnabled();
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (window as Window & { __rtlTestState?: { providerGets: number } })
            .__rtlTestState?.providerGets,
      ),
    )
    .toBe(1);

  await page.getByRole("button", { name: "Disconnect", exact: true }).click();
  await expect(page.locator(".receiver-status")).toContainText(
    "Receiver disconnected",
  );
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  await expect(page.locator(".receiver-status")).toContainText(
    "RTL-SDR connected",
  );
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (window as Window & { __rtlTestState?: { providerGets: number } })
            .__rtlTestState?.providerGets,
      ),
    )
    .toBe(2);
  await page.getByRole("button", { name: "Disconnect", exact: true }).click();
  await expect(page.locator(".receiver-status")).toContainText(
    "Receiver disconnected",
  );
});

test("WebGPU absence is an actionable fallback", async ({ page }) => {
  await page.addInitScript(() => {
    Reflect.deleteProperty(Navigator.prototype, "gpu");
  });
  await gotoApp(page);
  await expect(page.locator(".graphics-panel")).toContainText(
    "WebGPU is unavailable",
  );
  await page.getByRole("tab", { name: /Diagnostics/ }).click();
  await expect(
    page
      .getByText("WebGPU API", { exact: true })
      .locator("xpath=following-sibling::small"),
  ).toContainText("Use a WebGPU-compatible browser");
});

test("diagnostic reports default to automatic upload and remain reviewable and downloadable", async ({
  page,
}) => {
  await gotoApp(page);
  await page.getByRole("tab", { name: /Diagnostics/ }).click();
  await expect(
    page.getByRole("heading", { name: "Help improve BrowserSDR" }),
  ).toBeVisible();
  await expect(
    page.getByLabel(/Automatically send errors and recent diagnostic logs/),
  ).toBeChecked();
  await page.getByRole("button", { name: "Create diagnostic report" }).click();
  const dialog = page.getByRole("dialog", { name: /Diagnostic report/ });
  await expect(dialog).toBeVisible();
  await expect(
    dialog.getByRole("button", { name: "Send report" }),
  ).toBeEnabled();
  const downloadPromise = page.waitForEvent("download");
  await dialog.getByRole("button", { name: "Download JSON" }).click();
  const download = await downloadPromise;
  const path = await download.path();
  expect(path).not.toBeNull();
  const report = JSON.parse(await readFile(path!, "utf8")) as Record<
    string,
    unknown
  >;
  expect(report.schemaVersion).toBe(1);
  expect(report.reportId).toMatch(/^BR-/);
  expect(report.events).toEqual(expect.any(Array));
  expect(report.receiver).not.toHaveProperty("exactFrequencyHz");
  expect(report.redaction).toMatchObject({ exactFrequencyIncluded: false });
});

test("compatibility reports capture reviewed service evidence and receiver state", async ({
  page,
}) => {
  await gotoApp(page);
  await page.getByRole("tab", { name: /Help/ }).click();
  await page.getByRole("button", { name: "Share test result" }).click();
  const dialog = page.getByRole("dialog", { name: /Compatibility report/ });
  await expect(
    dialog.getByRole("button", { name: "Send report" }),
  ).toBeDisabled();
  await dialog.getByLabel("Device connection result").selectOption("working");
  await dialog
    .getByLabel("Spectrum & waterfall result")
    .selectOption("degraded");
  await expect(
    dialog.getByRole("button", { name: "Send report" }),
  ).toBeEnabled();
  const downloadPromise = page.waitForEvent("download");
  await dialog.getByRole("button", { name: "Download JSON" }).click();
  const download = await downloadPromise;
  const path = await download.path();
  expect(path).not.toBeNull();
  const report = JSON.parse(await readFile(path!, "utf8")) as Record<
    string,
    unknown
  >;
  expect(report.reportType).toBe("compatibility");
  expect(report.reportId).toMatch(/^BC-/);
  expect(report.observations).toEqual([
    { service: "connection", result: "working" },
    { service: "spectrum", result: "degraded" },
  ]);
  expect(report.receiver).not.toHaveProperty("exactFrequencyHz");
  expect(report.redaction).toMatchObject({ exactFrequencyIncluded: false });
});

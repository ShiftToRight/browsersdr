// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ReceiverApp } from "./App";
import { SpectrumExplorer } from "./ui/SpectrumExplorer";
import { AnalysisPipeline } from "./dsp/analysisPipeline";
import {
  ReceiverController,
  type ReceiverBackend,
  type ReceiverBackendEvents,
  type ReceiverStartOptions,
} from "./radio/receiverController";
import { hackrfRecordingFixture } from "./testing/hackrfRecordingFixture";
import type { SourceSessionMetadata } from "./radio/types";
import { USRP_B205_IMAGE } from "./radio/usrpB205Images";
import { usrpB205SessionDetails } from "./testing/usrpB205SessionFixture";
import { usrpB205FirmwareFixture } from "./testing/usrpB205FirmwareFixture";
vi.mock("./graphics/WebGpuSpectrum", () => ({ WebGpuSpectrum: () => null }));
vi.mock("./ui/SpectrumExplorer", () => ({
  SpectrumExplorer: vi.fn(() => null),
}));
let root: Root;
let controller: ReceiverController;
let analysis: AnalysisPipeline;
let metadata: SourceSessionMetadata;
let options: ReceiverStartOptions[];
let closeFailures = 0;
let closes = 0;
let hardwareCalls = 0;
let analogCalls: Array<{ bandwidthHz: number; squelch: number }> = [];
let backendEvents: ReceiverBackendEvents;
let connectionWait: Promise<void> | undefined;
beforeEach(async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  localStorage.clear();
  options = [];
  connectionWait = undefined;
  closes = 0;
  closeFailures = 0;
  hardwareCalls = 0;
  analogCalls = [];
  metadata = (await hackrfRecordingFixture()).session;
  const backend: ReceiverBackend = {
    connect: async (value) => {
      options.push(value);
      if (connectionWait) {
        backendEvents.permissionGranted();
        await connectionWait;
      }
      if (value.source === "usrp-b205") {
        const details = usrpB205SessionDetails(value.channelFrequencyHz);
        return {
          ...metadata,
          source: "usrp-b205",
          requestedSampleRateHz: 4_800_000,
          actualSampleRateHz: 4_800_000,
          hardwareCenterFrequencyHz: value.channelFrequencyHz,
          selectedChannelFrequencyHz: value.channelFrequencyHz,
          gainDb: null,
          hackrf: undefined,
          usrpB205: details,
        };
      }
      return {
        ...metadata,
        hardwareCenterFrequencyHz: value.channelFrequencyHz,
        selectedChannelFrequencyHz: value.channelFrequencyHz,
      };
    },
    start: async (value) => {
      options.push(value);
      return metadata;
    },
    stop: async () => undefined,
    disconnect: async () => {
      closes++;
      if (closeFailures-- > 0) throw new Error("USB close failed");
    },
    tune: async () => metadata,
    setVolume: () => undefined,
    setGain: async () => null,
    configureMode: async () => metadata,
    updateAnalogMode: (settings) => {
      analogCalls.push({
        bandwidthHz: settings.bandwidthHz,
        squelch: settings.squelch,
      });
      metadata = {
        ...metadata,
        mode: settings.mode,
        channelBandwidthHz: settings.bandwidthHz,
        squelch: settings.squelch,
        beatToneHz: settings.beatToneHz,
      };
      const { sessionGeneration: _generation, ...result } = metadata;
      return result;
    },
    configureHardware: async (settings) => {
      hardwareCalls++;
      metadata = {
        ...metadata,
        hackrf: {
          ...metadata.hackrf!,
          captureSettings: { ...metadata.hackrf!.captureSettings, ...settings },
        },
      };
      return metadata;
    },
  };
  controller = new ReceiverController((events) => {
    backendEvents = events;
    return backend;
  });
  analysis = new AnalysisPipeline(
    { postMessage() {}, terminate() {} } as unknown as Worker,
    "javascript",
  );
  const host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await act(async () =>
    root.render(
      <ReceiverApp
        controller={controller}
        analysis={analysis}
        replayRef={{ current: undefined }}
        usrpImageRef={{
          current: {
            contract: USRP_B205_IMAGE,
            bytes: new Uint8Array(),
            importedAs: "official-member",
            archiveSha256: null,
            memberSha256: USRP_B205_IMAGE.memberSha256,
            legacyHash: USRP_B205_IMAGE.legacyHash,
          },
        }}
        usrpFirmwareRef={{ current: usrpB205FirmwareFixture() }}
      />,
    ),
  );
});
afterEach(async () => {
  vi.useRealTimers();
  closeFailures = 0;
  await act(async () => {
    await controller.disconnect();
    root.unmount();
  });
  analysis.dispose();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  document.body.replaceChildren();
});
function control(label: string) {
  const element =
    Array.from(document.querySelectorAll("label"))
      .find((node) => node.textContent?.trim().startsWith(label))
      ?.querySelector("input,select") ??
    document.querySelector(`[aria-label="${label}"]`);
  if (!element) throw new Error(`Missing control ${label}`);
  return element as HTMLInputElement | HTMLSelectElement;
}
async function change(
  element: HTMLInputElement | HTMLSelectElement,
  value: string,
) {
  await act(async () => {
    const prototype =
      element instanceof HTMLSelectElement
        ? HTMLSelectElement.prototype
        : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(prototype, "value")!.set!.call(
      element,
      value,
    );
    element.dispatchEvent(
      new Event(element instanceof HTMLSelectElement ? "change" : "input", {
        bubbles: true,
      }),
    );
  });
}
async function toggle(element: HTMLInputElement) {
  await act(async () => element.click());
}
async function click(label: string) {
  const button = Array.from(document.querySelectorAll("button")).find(
    (node) => node.textContent === label,
  );
  if (!button) throw new Error(`Missing ${label}`);
  await act(async () => button.click());
}
it("exposes independent Pro stages, validates gain drafts before commands and shows accepted values", async () => {
  await change(control("Source"), "hackrf");
  expect(control("RX VGA gain").value).toBe("12");
  expect(document.querySelector('option[value="auto"]')).toBeNull();
  await click("Connect");
  expect(options[0]?.source).toBe("hackrf");
  expect(options[0]).not.toHaveProperty("gainDb");
  await change(control("RX VGA gain"), "3");
  await click("Apply RX settings");
  expect(hardwareCalls).toBe(0);
  expect(document.body.textContent).toContain("even integer");
  await change(control("RX LNA state"), "33");
  await change(control("RX VGA gain"), "62");
  await toggle(control("RF amplifier") as HTMLInputElement);
  await click("Apply RX settings");
  expect(hardwareCalls).toBe(1);
  expect(
    controller.getSnapshot().session?.hackrf?.captureSettings,
  ).toMatchObject({
    rxLnaGainCode: 33,
    rxVgaGainDb: 62,
    rfAmplifierEnabled: true,
    antennaPowerEnabled: false,
  });
});
it("renders only the receive-only B205 rates and never enables recording", async () => {
  await change(control("Source"), "usrp-b205");
  expect(control("Sample rate").value).toBe("4800000");
  expect(control("Sample rate").disabled).toBe(false);
  expect(
    Array.from((control("Sample rate") as HTMLSelectElement).options).map(
      (option) => option.value,
    ),
  ).toEqual(["4800000", "9600000", "19200000"]);
  expect(
    document.querySelector<HTMLOptionElement>('option[value="19200000"]')
      ?.textContent,
  ).toContain("experimental");
  expect(document.body.textContent).toContain(
    "RX2 antenna · internal clock/time · slow-attack AGC",
  );
  expect(document.body.textContent).toContain(
    "TX and persistent device-storage writes are disabled",
  );
  expect(document.body.textContent).not.toContain("Local testing uses");
  expect(document.body.textContent).not.toContain("DDC-calculated setting");
  const acquire = document.querySelector(".acquire-stage")!;
  expect(acquire.textContent).toContain("✓ Firmware verified");
  expect(acquire.textContent).toContain("✓ FPGA image verified");
  expect(
    acquire.querySelector<HTMLDetailsElement>(".advanced-settings")?.open,
  ).toBe(false);
  expect(acquire.querySelectorAll(".setup-file-verified")).toHaveLength(2);
  expect(acquire.querySelectorAll('input[type="file"]')).toHaveLength(2);
  const checklist = acquire.querySelector(".setup-checklist")!;
  expect(
    checklist.compareDocumentPosition(
      acquire.querySelector(".connection-stack")!,
    ) & Node.DOCUMENT_POSITION_FOLLOWING,
  ).toBeTruthy();
  expect(document.body.textContent).not.toContain("Requested manual gain");
  await click("Connect");
  expect(options.at(-1)).toMatchObject({
    source: "usrp-b205",
    sampleRateHz: 4_800_000,
    usrpSettings: {
      antenna: "RX2",
      clockSource: "internal",
      timeSource: "internal",
      gainMode: "slow_agc",
      gainDb: null,
    },
  });
  const captureTab = Array.from(document.querySelectorAll("button")).find(
    (button) => button.textContent === "Capture & replay",
  )!;
  await act(async () => captureTab.click());
  expect(
    Array.from(document.querySelectorAll("button"))
      .find((button) => button.textContent === "Start I/Q recording")
      ?.hasAttribute("disabled"),
  ).toBe(true);
  expect(document.body.textContent).toContain("SigMF hardware claims");
});
it("selects a source-compatible digital rate before connect and keeps stopped configuration editable", async () => {
  await change(control("Source"), "hackrf");
  await change(control("Mode"), "DAB");
  expect(control("Sample rate").value).toBe("2400000");
  expect(control("Volume").disabled).toBe(false);
  expect(document.body.textContent).toContain("DAB+ audio");
  await change(control("Mode"), "AM");
  await change(control("Sample rate"), "1024000");
  await click("Connect");
  const dab = document.querySelector<HTMLOptionElement>('option[value="DAB"]')!;
  expect(dab.disabled).toBe(false);
  await change(control("Mode"), "DAB");
  expect(control("Sample rate").value).toBe("2400000");
  expect(controller.getSnapshot().session?.source).toBe("hackrf");
});
it("offers spectrum-only tuning with the audio control disabled", async () => {
  await change(control("Source"), "hackrf");
  const off = document.querySelector<HTMLOptionElement>('option[value="OFF"]')!;
  expect(off.textContent).toContain("Spectrum only");
  await change(control("Mode"), "OFF");
  expect(control("Volume").disabled).toBe(true);
  expect(document.body.textContent).toContain(
    "Demodulation and audio are disabled",
  );
  expect(document.body.textContent).toContain("Spectrum only");
  await click("Connect");
  await click("Start receiving");
  expect(options.at(-1)?.modeSettings).toEqual({
    mode: "OFF",
    bandwidthHz: 1,
    squelch: 0,
    beatToneHz: 600,
  });
});
it("changes a persistent device rate while stopped without disconnecting", async () => {
  await change(control("Source"), "hackrf");
  await change(control("Mode"), "AM");
  await click("Connect");
  expect(controller.getSnapshot().lifecycle).toBe("connected");
  expect(control("Sample rate").disabled).toBe(false);
  await click("Start receiving");
  expect(control("Sample rate").disabled).toBe(true);
  await click("Stop receiving");
  expect(controller.getSnapshot().lifecycle).toBe("connected");
  expect(control("Sample rate").disabled).toBe(false);
  await change(control("Sample rate"), "9600000");
  await click("Start receiving");
  expect(options.at(-1)).toMatchObject({
    source: "hackrf",
    sampleRateHz: 9_600_000,
  });
  expect(closes).toBe(0);
});
it("holds source ownership on cleanup failure and restores source-specific choices after retry", async () => {
  await change(control("Source"), "hackrf");
  await change(control("RX VGA gain"), "26");
  await click("Connect");
  closeFailures = 1;
  await change(control("Source"), "synthetic");
  expect(control("Source").value).toBe("hackrf");
  expect(controller.getSnapshot().cleanupRequired).toBe(true);
  await click("Disconnect");
  await change(control("Source"), "synthetic");
  expect(closes).toBe(2);
  expect(document.body.textContent).not.toContain("RX VGA gain");
  await change(control("Source"), "hackrf");
  expect(control("RX VGA gain").value).toBe("26");
});

it("exposes a top-level help view with scoped compatibility evidence and a demo shortcut", async () => {
  await change(control("Source"), "hackrf");
  await change(control("RX LNA state"), "33");
  await change(control("RX VGA gain"), "20");
  await toggle(control("RF amplifier") as HTMLInputElement);
  await act(async () =>
    (document.querySelector("#help-tab") as HTMLButtonElement).click(),
  );
  expect(
    document.querySelector("#help-tab")?.getAttribute("aria-selected"),
  ).toBe("true");
  expect(document.querySelector<HTMLDivElement>("#help-view")?.hidden).toBe(
    false,
  );
  expect(document.body.textContent).toContain("Tested receiver setups");
  const overview = document.querySelector(".compatibility-overview")!;
  expect(overview.querySelectorAll(".compat-status.is-validated")).toHaveLength(
    4,
  );
  expect(overview.querySelectorAll(".compat-status.is-unclear")).toHaveLength(
    1,
  );
  const compatibilityDetails = document.querySelector<HTMLDetailsElement>(
    ".compatibility-details",
  )!;
  expect(compatibilityDetails.open).toBe(false);
  await act(async () => compatibilityDetails.querySelector("summary")?.click());
  expect(compatibilityDetails.open).toBe(true);
  expect(
    document.querySelector("#compatibility-modes-panel")?.textContent,
  ).toContain("DAB / DAB+");
  await act(async () =>
    (
      document.querySelector(
        "#compatibility-recording-tab",
      ) as HTMLButtonElement
    ).click(),
  );
  expect(
    document
      .querySelector("#compatibility-recording-tab")
      ?.getAttribute("aria-selected"),
  ).toBe("true");
  expect(
    document.querySelector<HTMLDivElement>("#compatibility-recording-panel")
      ?.hidden,
  ).toBe(false);
  expect(
    document.querySelector("#compatibility-recording-panel")?.textContent,
  ).toContain("SigMF data + metadata");
  await act(async () =>
    (
      document.querySelector("#compatibility-browsers-tab") as HTMLButtonElement
    ).click(),
  );
  expect(
    document.querySelector("#compatibility-browsers-panel")?.textContent,
  ).toContain("Firefox · desktop");
  expect(
    compatibilityDetails.querySelectorAll(".compat-status.is-available").length,
  ).toBeGreaterThan(0);
  expect(
    compatibilityDetails.querySelectorAll(".compat-status.is-experimental")
      .length,
  ).toBeGreaterThan(0);
  expect(
    compatibilityDetails.querySelectorAll(".compat-status.is-unsupported")
      .length,
  ).toBeGreaterThan(0);
  expect(document.body.textContent).toContain(
    "Does BrowserSDR upload my radio data?",
  );
  expect(document.body.textContent).toContain("Share a compatibility test");
  await click("Share test result");
  const compatibilityDialog = document.querySelector(
    ".compatibility-report-dialog",
  )!;
  expect(compatibilityDialog.textContent).toContain("Compatibility report BC-");
  const send = Array.from(compatibilityDialog.querySelectorAll("button")).find(
    (button) => button.textContent === "Send report",
  ) as HTMLButtonElement;
  expect(send.disabled).toBe(true);
  await change(control("Device connection result"), "working");
  expect(send.disabled).toBe(false);
  expect(compatibilityDialog.textContent).toContain('"source": "hackrf"');
  expect(compatibilityDialog.textContent).toContain('"lnaGainCode": 33');
  expect(compatibilityDialog.textContent).toContain('"vgaGainDb": 20');
  expect(compatibilityDialog.textContent).toContain(
    '"rfAmplifierEnabled": true',
  );
  const preview = () =>
    JSON.parse(compatibilityDialog.querySelector("pre")!.textContent!);
  expect(preview().receiver).not.toHaveProperty("exactFrequencyHz");
  await toggle(control("Include exact tuned frequency") as HTMLInputElement);
  expect(preview().receiver).toHaveProperty("exactFrequencyHz", 100_000_000);
  await click("Cancel");

  await click("Try the no-hardware demo");
  expect(
    document.querySelector("#receiver-tab")?.getAttribute("aria-selected"),
  ).toBe("true");
  expect(control("Source").value).toBe("synthetic");
});

it("exposes licence, driver provenance, and privacy information in About", async () => {
  await act(async () =>
    (document.querySelector("#about-tab") as HTMLButtonElement).click(),
  );
  expect(
    document.querySelector("#about-tab")?.getAttribute("aria-selected"),
  ).toBe("true");
  expect(document.querySelector<HTMLDivElement>("#about-view")?.hidden).toBe(
    false,
  );
  expect(document.body.textContent).toContain("Licences, privacy & provenance");
  expect(document.body.textContent).toContain(
    "Automatic error reporting is off until you enable it in Diagnostics",
  );
  expect(document.body.textContent).toContain(
    "Analog Devices no-OS · BSD-3-Clause",
  );
});

it("integrates the signal path into the header and progressively reveals mode-aware settings", async () => {
  const rail = document.querySelector(".operational-rail");
  expect(rail?.textContent).toContain("RTL-SDR");
  expect(rail?.textContent).toContain("100.000000 MHz");
  expect(rail?.textContent).toContain("WBFM audio");
  expect(
    document.querySelector(".signal-chain-panel > .panel-heading"),
  ).toBeNull();

  const sourceSettings = () =>
    document.querySelector<HTMLDetailsElement>(
      ".acquire-stage .advanced-settings",
    )!;
  const channelSettings = () =>
    document.querySelector<HTMLDetailsElement>(".channel-advanced-settings")!;
  expect(sourceSettings().open).toBe(false);
  expect(channelSettings().open).toBe(false);

  await change(control("Source"), "hackrf");
  expect(sourceSettings().open).toBe(false);
  await change(control("Mode"), "AM");
  expect(channelSettings().open).toBe(true);
  expect(channelSettings().textContent).toContain("squelch 0.0");

  await click("Connect");
  await click("Start receiving");
  expect(
    document.querySelector(".acquire-connection-status")?.textContent,
  ).toBe("● Receiving");
});

it("applies AM bandwidth and squelch live while leaving Tune as the explicit action", async () => {
  await change(control("Source"), "hackrf");
  await change(control("Mode"), "AM");
  await click("Connect");
  await click("Start receiving");
  const generation = controller.getSnapshot().sessionGeneration;

  await change(control("Channel bandwidth"), "4000");
  await change(control("Squelch"), "2.2");

  expect(analogCalls).toEqual([
    { bandwidthHz: 4000, squelch: 0 },
    { bandwidthHz: 4000, squelch: 2.2 },
  ]);
  expect(controller.getSnapshot()).toMatchObject({
    lifecycle: "running",
    sessionGeneration: generation,
    session: { channelBandwidthHz: 4000, squelch: 2.2 },
  });
  expect(document.body.textContent).not.toContain("Apply channel");
  expect(
    Array.from(document.querySelectorAll("button")).some(
      (button) => button.textContent === "Tune",
    ),
  ).toBe(true);
});

it("shows live channel quality and can set squelch just above measured noise", async () => {
  await change(control("Source"), "hackrf");
  await change(control("Mode"), "AM");
  await click("Connect");
  await click("Start receiving");
  vi.useFakeTimers();

  await act(async () =>
    backendEvents.squelchChanged?.({ level: 1.2, peak: 2.4, open: true }),
  );
  const meter = document.querySelector<HTMLElement>(
    '[role="meter"][aria-label="Current channel quality"]',
  )!;
  expect(meter.getAttribute("aria-valuenow")).toBe("1.2");
  expect(
    document.querySelector(
      '.squelch-meter-control input[aria-label="Squelch"]',
    ),
  ).not.toBeNull();
  expect(document.body.textContent).toContain("Audio open");

  await click("Auto set");
  await act(async () => {
    backendEvents.squelchChanged?.({ level: 1.0, peak: 1.4, open: true });
    backendEvents.squelchChanged?.({ level: 1.2, peak: 1.4, open: true });
    backendEvents.squelchChanged?.({ level: 1.1, peak: 1.4, open: true });
    await vi.advanceTimersByTimeAsync(2_000);
  });

  expect(control("Squelch").value).toBe("1.4");
  expect(analogCalls.at(-1)).toEqual({ bandwidthHz: 15000, squelch: 1.4 });
  expect(document.body.textContent).toContain(
    "Set just above the measured noise at 1.4",
  );
});

it("shows CW filter presets and changes beat tone without changing RF frequency", async () => {
  await change(control("Source"), "hackrf");
  await change(control("Mode"), "CW");
  expect(control("Receive filter bandwidth").value).toBe("500");
  expect(
    Array.from(
      (control("Receive filter bandwidth") as HTMLSelectElement).options,
    ).map((option) => option.value),
  ).toEqual(["100", "250", "500", "1000"]);
  expect(control("Beat tone").value).toBe("600");
  const frequency = control("Channel frequency").value;
  await change(control("Beat tone"), "900");
  expect(control("Channel frequency").value).toBe(frequency);
  expect(
    document.querySelector(".channel-advanced-settings")?.textContent,
  ).toContain("900 Hz tone");
});

it("creates a reviewable diagnostic report and exposes reporting after a receiver failure", async () => {
  await act(async () =>
    (document.querySelector("#diagnostics-tab") as HTMLButtonElement).click(),
  );
  expect(document.body.textContent).toContain("Help improve BrowserSDR");
  await click("Create diagnostic report");
  expect(document.querySelector('[role="dialog"]')?.textContent).toContain(
    "Review before sending",
  );
  expect(
    (
      Array.from(document.querySelectorAll("button")).find(
        (button) => button.textContent === "Send report",
      ) as HTMLButtonElement
    ).disabled,
  ).toBe(false);
  await click("Cancel");

  await act(async () =>
    controller.start({
      source: "hackrf",
      channelFrequencyHz: -1,
      volume: 0.5,
      modeSettings: { mode: "WBFM", bandwidthHz: 180_000, squelch: 0 },
      sampleRateHz: 4_800_000,
    }),
  );
  expect(document.body.textContent).toContain("Review & send report");
  await click("Review & send report");
  expect(document.querySelector('[role="dialog"]')).not.toBeNull();
});

it("polls visible diagnostics only while keeping hidden health snapshots", async () => {
  vi.useFakeTimers();
  await change(control("Source"), "hackrf");
  await click("Connect");
  const reads = vi.spyOn(analysis, "getDiagnostics");
  reads.mockClear();
  await act(async () => {
    await vi.advanceTimersByTimeAsync(1_500);
  });
  expect(reads).not.toHaveBeenCalled();
  await act(async () => {
    await vi.advanceTimersByTimeAsync(500);
  });
  expect(reads).toHaveBeenCalledOnce(); // health monitor remains active
  await act(async () =>
    document.querySelector<HTMLElement>("#diagnostics-tab")!.click(),
  );
  reads.mockClear();
  await act(async () => {
    await vi.advanceTimersByTimeAsync(1_000);
  });
  expect(reads).toHaveBeenCalledTimes(2);
  await act(async () =>
    document.querySelector<HTMLElement>("#receiver-tab")!.click(),
  );
  reads.mockClear();
  await act(async () => {
    await vi.advanceTimersByTimeAsync(500);
  });
  expect(reads).not.toHaveBeenCalled();
});

it("updates DAB audio telemetry without rebuilding the receiver controls or hidden views", async () => {
  await change(control("Source"), "hackrf");
  await change(control("Mode"), "DAB");
  await click("Connect");
  await click("Start receiving");
  const renders = vi.mocked(SpectrumExplorer).mock.calls.length;
  expect(document.querySelector(".compatibility-overview")).toBeNull();
  for (const seconds of [1.2, 2.4, 3.6]) {
    await act(async () =>
      backendEvents.dabChanged?.({
        state: "synchronized",
        frameCount: 40,
        nullSymbolCount: 40,
        estimatedSnrDb: null,
        coarseFrequencyOffsetHz: 120,
        message: "Decoding test programme",
        decodedAudioSeconds: seconds,
        pcmSampleRateHz: 48000,
      }),
    );
    expect(document.querySelector(".decode-panel")?.textContent).toContain(
      `${seconds.toFixed(2)} s`,
    );
  }
  expect(vi.mocked(SpectrumExplorer).mock.calls.length).toBe(renders);
  await click("Stop receiving");
  expect(document.querySelector(".operational-rail")?.textContent).toContain(
    "connected",
  );
});

it("shows connection activity until initialization finishes, then enables reception", async () => {
  await change(control("Source"), "usrp-b205");
  let finish!: () => void;
  connectionWait = new Promise<void>((resolve) => {
    finish = resolve;
  });
  await click("Connect");
  const button = document.querySelector<HTMLButtonElement>(".acquire-connect")!;
  expect(button.textContent).toBe("Connecting & initializing…");
  expect(button.getAttribute("aria-busy")).toBe("true");
  expect(button.classList.contains("is-connecting")).toBe(true);
  expect(button.disabled).toBe(true);
  expect(
    document.querySelector<HTMLButtonElement>(".acquire-receive")?.disabled,
  ).toBe(true);
  expect(document.querySelector(".setup-checklist")?.textContent).toContain(
    "✓ Firmware verified",
  );
  await act(async () => {
    finish();
    await connectionWait;
  });
  expect(document.querySelector(".acquire-connect")).toBeNull();
  expect(
    document.querySelector(".acquire-connection-status")?.textContent,
  ).toBe("✓ Connected");
  expect(
    document.querySelector<HTMLButtonElement>(".acquire-receive")?.disabled,
  ).toBe(false);
  await click("Disconnect");
  expect(document.querySelector(".acquire-connect")?.textContent).toBe(
    "Connect",
  );
  expect(document.querySelector(".setup-checklist")?.textContent).toContain(
    "✓ Firmware verified",
  );
});

it("uses the same verified checklist for bladeRF and keeps failed replacement errors visible", async () => {
  const images = await import("./radio/bladerfImages");
  vi.spyOn(images, "importBladeRfImage").mockResolvedValue(
    images.BLADERF_HOSTED_IMAGES[0]!,
  );
  vi.spyOn(images, "storedBladeRfImageVersions").mockResolvedValue(["0.15.3"]);
  await change(control("Source"), "bladerf");
  const input = document.querySelector<HTMLInputElement>(
    '.setup-checklist input[type="file"]',
  )!;
  Object.defineProperty(input, "files", {
    configurable: true,
    value: [new File(["fixture"], "image.rbf")],
  });
  await act(async () => {
    input.dispatchEvent(new Event("change", { bubbles: true }));
  });
  expect(document.querySelector(".setup-file-verified")?.textContent).toBe(
    "✓ FPGA image verified",
  );
  expect(input.getAttribute("aria-label")).toBe("Replace fpga image");
  vi.mocked(images.importBladeRfImage).mockRejectedValue(
    new Error("Image checksum does not match"),
  );
  await act(async () => {
    input.dispatchEvent(new Event("change", { bubbles: true }));
  });
  expect(document.querySelector(".setup-file-error")?.textContent).toBe(
    "Image checksum does not match",
  );
  expect(document.querySelector(".setup-file-verified")?.textContent).toBe(
    "✓ FPGA image verified",
  );
});

import {
  openDeviceSettings,
  closeDeviceSettings,
} from "./device-settings-navigation";
import { expect, test, type Page } from "@playwright/test";

async function installUsrpb205(page: Page, authorized = false) {
  await page.addInitScript((hasAuthorization) => {
    const device = {
      vendorId: 0x2500,
      productId: 0x0022,
      serialNumber: "FIXTURE",
    };
    const state = {
      chooserCalls: 0,
      chooserHadActivation: false,
      grantedOpens: 0,
      starts: 0,
      stops: 0,
      closes: 0,
      device,
    };
    (window as unknown as { __usrpB205: typeof state }).__usrpB205 = state;
    const usb = {
      requestDevice: () => {
        state.chooserCalls++;
        state.chooserHadActivation = navigator.userActivation.isActive;
        hasAuthorization = true;
        return Promise.resolve(device);
      },
      getDevices: () => Promise.resolve(hasAuthorization ? [device] : []),
    };
    Object.defineProperty(navigator, "usb", { configurable: true, value: usb });

    const imageContract = {
      uhdVersion: "4.9.0.0",
      uhdCommit: "006d7f7646fb66f2ae635cb44ef6442a6ad4fba7",
      sourceId: "uhd-c37b318",
      manifestTarget: "b2xx_b205mini_fpga_default",
      archiveFilename: "b2xx_b205mini_fpga_default-gc37b318.zip",
      archiveUrl:
        "https://files.ettus.com/binaries/cache/b2xx/uhd-c37b318/b2xx_b205mini_fpga_default-gc37b318.zip",
      archiveSha256:
        "dce96120e3512d6e21bb061811c4021cbc90ac4d787248ad821337b7389ff3c4",
      memberFilename: "usrp_b205mini_fpga.bin",
      memberByteLength: 4_223_252,
      memberSha256:
        "f4da0becf906af957c954a7a1c276aa91f79ca369d7aedf7c2f5c7fdebf4c351",
      legacyHash: 0x1624155e,
      fpgaCompatibility: "7.0",
      reservedPublicUrl: "/assets/usrp-b205/uhd-4.9.0.0/usrp_b205mini_fpga.bin",
      redistribution: "not-approved-user-import-only",
      licenseNotice: "fixture",
    };
    const firmwareContract = {
      uhdVersion: "4.9.0.0",
      uhdCommit: imageContract.uhdCommit,
      sourceId: "uhd-7f7d016",
      manifestTarget: "b2xx_common_fw_default",
      archiveFilename: "b2xx_common_fw_default-g7f7d016.zip",
      archiveUrl:
        "https://files.ettus.com/binaries/cache/b2xx/uhd-7f7d016/b2xx_common_fw_default-g7f7d016.zip",
      archiveSha256:
        "22ac0e54cc90d53d8494d481439447a0c89b9bbaced6fabe24df260eda3ce3a3",
      memberFilename: "usrp_b200_fw.hex",
      memberByteLength: 514346,
      memberSha256:
        "cc8e4bc968d91d1a67c63871ce5b2c1613c49676fe363bf2f6e336059899ae5c",
      entryAddress: 0x40019dec,
      redistribution: "not-approved-user-import-only",
    };
    const session = (center: number, rate = 4_800_000) => ({
      capabilities: {
        source: "usrp-b205",
        phase: "discovered",
        protocolProfile: "usrp-b205-mini-uhd-4.9.0.0-rx-v2",
        uhdReferenceCommit: imageContract.uhdCommit,
        identity: {
          kind: "usrp-b205-mini",
          vendorId: 0x2500,
          productId: 0x0022,
          productName: "USRP B205-mini fixture",
          serialNumber: "FIXTURE",
        },
        descriptorLayoutVerified: true,
        firmware: { major: 8, minor: 0 },
        fpga: {
          signature: 0xace0ba5e,
          compatibilityMajor: 7,
          compatibilityMinor: 0,
          imageSha256: imageContract.memberSha256,
          legacyHash: imageContract.legacyHash,
        },
        usbSpeed: "super-speed",
        nativeEncoding: "chdr-vrt-sc16-le",
        sampleWordOrder: "i16-msw-q16-lsw",
        sampleByteOrder: "q-lo-q-hi-i-lo-i-hi",
        sampleScaling: "float=int16*0.9999997558594347/32767",
        hardwareValidation: "pending",
      },
      nativeEncoding: "chdr-vrt-sc16-le",
      nativeSampleRateHz: rate,
      effectiveSampleRateHz: 2_400_000,
      configuration: {
        requested: {
          kind: "usrp-b205",
          antenna: "RX2",
          clockSource: "internal",
          timeSource: "internal",
          gainMode: "slow_agc",
          gainDb: null,
          requestedCenterFrequencyHz: center,
          requestedSampleRateHz: rate,
          requestedBandwidthHz: rate,
        },
        acceptedCenterFrequencyHz: center,
        centerFrequencyEvidence: "rf-synthesizer-calculated",
        acceptedSampleRateHz: rate,
        sampleRateEvidence: "ddc-calculated",
        acceptedBandwidthHz: rate - 2,
        bandwidthEvidence: "ad9361-readback",
        acceptedMasterClockRateHz: 38_400_000,
        masterClockEvidence: "rf-driver-calculated",
        acceptedAntenna: "RX2",
        acceptedClockSource: "internal",
        acceptedTimeSource: "internal",
        acceptedGainMode: "slow_agc",
        acceptedGainDb: null,
      },
      observations: {
        ad9364DeviceIdVerified: true,
        rxPllLocked: true,
        timestampRateValidation: "pending",
      },
      hardwareValidation: "pending",
    });
    let details = session(100_000_000);
    const identity = {
      kind: "usrp-b205-mini-fx3",
      vendorId: 0x2500,
      productId: 0x0022,
      productName: "USRP B205-mini fixture",
      serialNumber: "FIXTURE",
      descriptorLayoutVerified: true,
      firmware: { major: 8, minor: 0 },
      usbSpeed: 3,
      loaderState: 4,
      fpgaLegacyHash: imageContract.legacyHash,
      imageSha256: imageContract.memberSha256,
      imageDisposition: "already-compatible",
      claimedInterfaces: [4, 3, 2],
      fpgaCompatibilityCheck: "pending-chdr-step-04",
    };
    const connection = {
      diagnostics: { state: "ready" },
      claimedBulkIo: () => ({}),
      requestAndOpen: async () => {
        await usb.requestDevice();
        return identity;
      },
      open: async () => {
        state.grantedOpens++;
        return identity;
      },
      close: async () => {
        state.closes++;
      },
    };
    const configurator = {
      diagnostics: {
        stage: "configured-stopped",
        rfStateUnknown: false,
        powerCycleRequired: false,
      },
      initialize: async (request: {
        requestedCenterFrequencyHz: number;
        requestedSampleRateHz: number;
      }) =>
        (details = session(
          request.requestedCenterFrequencyHz,
          request.requestedSampleRateHz,
        )),
      startContinuous: async () => {
        state.starts++;
      },
      stopContinuous: async () => {
        state.stops++;
      },
      retune: async (
        center: number,
        boundary: {
          stopAndDrain(): Promise<void>;
          incrementGenerationAndDiscardOldPackets(): void;
          acceptSession(value: unknown): void;
          resetExpectedRxSequence(): void;
          restart(): Promise<void>;
        },
      ) => {
        await boundary.stopAndDrain();
        boundary.incrementGenerationAndDiscardOldPackets();
        details = session(center, details.nativeSampleRateHz);
        boundary.acceptSession(details);
        boundary.resetExpectedRxSequence();
        await boundary.restart();
        return details;
      },
    };
    const transport = {
      get observedSessionDetails() {
        return structuredClone(details);
      },
      diagnostics: { state: "configured" },
      start: async () => {
        state.starts++;
      },
      stopAndDrain: async () => {
        state.stops++;
      },
      incrementGenerationAndDiscardOldPackets: () => undefined,
      acceptSession: (value: typeof details) => {
        details = structuredClone(value);
      },
      resetExpectedRxSequence: () => undefined,
      restart: async () => undefined,
      close: async () => undefined,
    };
    const pipeline = {
      audioState: "suspended",
      setSampleRate: () => undefined,
      receiveSamples: () => undefined,
      resume: async () => {
        pipeline.audioState = "running";
      },
      requireRunning: () => undefined,
      validateRateBudget: () => undefined,
      prepare: async () => undefined,
      begin: () => undefined,
      retune: () => undefined,
      markDiscontinuity: () => undefined,
      reset: () => undefined,
      suspend: async () => {
        pipeline.audioState = "suspended";
      },
      close: async () => {
        pipeline.audioState = "closed";
      },
      setVolume: () => undefined,
      updateAnalogMode: () => undefined,
      selectDabService: () => undefined,
      channelDiagnostics: undefined,
    };
    (
      window as unknown as { __BROWSERSDR_TEST_CONFIG__: unknown }
    ).__BROWSERSDR_TEST_CONFIG__ = {
      usrpB205Dependencies: {
        usb,
        image: {
          contract: imageContract,
          bytes: new Uint8Array(),
          importedAs: "official-member",
          archiveSha256: null,
          memberSha256: imageContract.memberSha256,
          legacyHash: imageContract.legacyHash,
        },
        firmware: {
          contract: firmwareContract,
          text: ":0400000540019DEC2D\n:00000001FF\n",
          importedAs: "official-member",
          archiveSha256: null,
          memberSha256: firmwareContract.memberSha256,
        },
        createAd9364Driver: () => ({}),
        createConnection: () => connection,
        createControl: () => ({
          start: () => undefined,
          close: async () => undefined,
        }),
        createConfigurator: () => configurator,
        createTransport: () => transport,
        createPipeline: () => pipeline,
      },
    };
    if (hasAuthorization)
      localStorage.setItem("browsersdr.selectedSource", "usrp-b205");
  }, authorized);
}

test("B205-mini mocked browser flow keeps permission synchronous and receive-only", async ({
  page,
}) => {
  await installUsrpb205(page);
  await page.goto("/?browser-test=1");
  await page
    .getByRole("combobox", { name: "Signal source" })
    .selectOption("usrp-b205");
  await openDeviceSettings(page);
  const sampleRate = page.getByLabel("Sample rate", { exact: false });
  await expect(sampleRate).toBeEnabled();
  await sampleRate.selectOption("9600000");
  await expect(page.locator(".device-setup-details")).toBeVisible();
  await closeDeviceSettings(page);
  await page
    .getByRole("button", {
      name: "Connect",
    })
    .click();
  await expect(page.locator(".receiver-status")).toContainText("connected");
  await page.getByRole("button", { name: "Start receiving" }).click();
  await expect(page.locator(".receiver-session-details")).toContainText(
    "CHDR/VRT SC16 LE",
  );
  await expect(page.locator(".receiver-session-details")).toContainText(
    "native 9,600,000 samples/s",
  );
  await expect(page.locator(".receiver-session-details")).toContainText(
    "synthesizer-calculated accepted",
  );
  await page.getByRole("tab", { name: "Capture & replay" }).click();
  await expect(
    page.getByRole("button", { name: "Start I/Q recording" }),
  ).toBeEnabled();
  await expect(sampleRate).toBeDisabled();
  await page.getByRole("button", { name: "Stop receiving" }).click();
  await expect(sampleRate).toBeEnabled();
  await openDeviceSettings(page);
  await sampleRate.selectOption("19200000");
  await expect(
    page.getByText("Change pending · applies when reception starts", {
      exact: true,
    }),
  ).toBeVisible();
  await closeDeviceSettings(page);
  await page.getByRole("button", { name: "Start receiving" }).click();
  await expect(page.locator(".receiver-session-details")).toContainText(
    "native 19,200,000 samples/s",
  );
  await expect(sampleRate).toBeDisabled();
  await page.getByRole("button", { name: "Stop receiving" }).click();
  await expect(sampleRate).toBeEnabled();
  await page.getByRole("button", { name: "Disconnect" }).click();
  const state = await page.evaluate(
    () => (window as unknown as { __usrpB205: unknown }).__usrpB205,
  );
  expect(state).toMatchObject({
    chooserCalls: 1,
    chooserHadActivation: true,
    starts: 2,
  });
});

test("B205-mini authorized-device reconnect does not open a chooser", async ({
  page,
}) => {
  await installUsrpb205(page, true);
  await page.goto("/?browser-test=1");
  await expect(page.locator(".receiver-status")).toContainText("connected");
  const state = await page.evaluate(
    () => (window as unknown as { __usrpB205: unknown }).__usrpB205,
  );
  expect(state).toMatchObject({ chooserCalls: 0, grantedOpens: 1 });
});

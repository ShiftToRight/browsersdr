// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type {
  ReceiverController,
  ReceiverSnapshot,
} from "../radio/receiverController";
import {
  DecoderWorkspace,
  type DecoderWorkspaceProps,
} from "./DecoderWorkspace";
import { DecodedResults } from "./DecodedResults";

let root: Root;
let receiver: ReceiverSnapshot;
let listeners: Set<() => void>;
let props: DecoderWorkspaceProps;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  receiver = {
    lifecycle: "running",
    message: "Receiving",
    sessionGeneration: 1,
    rds: {
      pi: "1234",
      programmeService: "FIRST",
      radioText: "original",
      validGroups: 3,
    },
  };
  listeners = new Set();
  const controller = {
    getSnapshot: () => receiver,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  } as unknown as ReceiverController;
  props = {
    controller,
    source: "rtl-sdr",
    mode: "WBFM",
    configuredMode: "WBFM",
    volume: 0.7,
    frequencyHz: 100_000_000,
    sampleRateHz: 1_024_000,
    active: true,
    remote: false,
    unavailableReason: () => undefined,
    configurationPreview: () => "Preview",
    onApply: vi.fn(),
    onOpenReceiver: vi.fn(),
    onOpenRecording: vi.fn(),
    onVolumeChange: vi.fn(),
  };
});
afterEach(async () => {
  await act(async () => root.unmount());
  document.body.replaceChildren();
  vi.unstubAllGlobals();
});
async function render() {
  await act(async () => root.render(<DecoderWorkspace {...props} />));
}
async function click(text: string) {
  const button = [
    ...document.querySelectorAll<HTMLButtonElement>("button"),
  ].find((b) => b.textContent === text)!;
  expect(button).toBeTruthy();
  await act(async () => button.click());
}
async function publish(snapshot: ReceiverSnapshot) {
  await act(async () => {
    receiver = snapshot;
    listeners.forEach((l) => l());
  });
}

it.each(["ADS-B", "AIS"] as const)(
  "%s keeps targets in the dock and opens the linked map only in Decoder",
  async (mode) => {
    const position = { latitude: 52, longitude: 13 };
    const track = [
      { latitude: 51.9, longitude: 12.9, timeMs: 0 },
      { ...position, timeMs: 100 },
    ];
    receiver = {
      ...receiver,
      adsb: {
        frames: 2,
        preamblesDetected: 2,
        validFrames: 2,
        crcValidFrames: 2,
        unsupportedFrames: 0,
        crcFailures: 0,
        ambiguousFrames: 0,
        rejectedFrames: 0,
        message: "Decoded aircraft",
        targets: [true, false].map((positioned, index) => ({
          icao: `00000${index}`,
          callsign: `TARGET${index}`,
          category: "A7",
          track: positioned ? track : [],
          altitudeFt: null,
          groundSpeedKt: null,
          trackDegrees: null,
          verticalRateFpm: null,
          emergency: null,
          messages: 1,
          lastSeenMs: 100,
          ...(positioned ? position : { latitude: null, longitude: null }),
        })),
      },
      ais: {
        frames: 2,
        validFrames: 2,
        rejectedFrames: 0,
        channel1Frames: 2,
        channel2Frames: 0,
        message: "Decoded vessels",
        targets: [true, false].map((positioned, index) => ({
          mmsi: 123456780 + index,
          name: `TARGET${index}`,
          track: positioned ? track : [],
          callSign: null,
          shipType: null,
          speedKnots: null,
          courseDegrees: null,
          headingDegrees: null,
          navigationStatus: null,
          channel: "AIS 1",
          messages: 1,
          lastSeenMs: 100,
          ...(positioned ? position : { latitude: null, longitude: null }),
        })),
      },
    };
    props = { ...props, mode, configuredMode: mode };
    const onOpenDecoder = vi.fn();
    await act(async () =>
      root.render(
        <DecodedResults
          receiver={receiver}
          source={props.source}
          mode={mode}
          volume={props.volume}
          onOpenDecoder={onOpenDecoder}
        />,
      ),
    );
    expect(document.querySelector(".target-plot")).toBeNull();
    expect(document.querySelector(".target-table")?.textContent).toContain(
      "TARGET0",
    );
    expect(document.querySelector(".target-table")?.textContent).toContain(
      "TARGET1",
    );
    expect(
      [...document.querySelectorAll<HTMLButtonElement>("button")].find(
        (button) => button.textContent === "Export targets JSON",
      )?.disabled,
    ).toBe(false);
    await click("Open Decoder");
    expect(onOpenDecoder).toHaveBeenCalledOnce();
    await render();
    expect(
      document.querySelector(".target-plot svg")?.getAttribute("aria-label"),
    ).toBe(`${mode} decoded positions: 1 positioned targets`);
    expect(document.querySelectorAll(".decoder-record")).toHaveLength(2);
    expect(
      document.querySelector(".map-target-symbol")?.getAttribute("data-symbol"),
    ).toBe(mode === "ADS-B" ? "helicopter" : "vessel");
    expect(document.querySelectorAll(".map-track path")).toHaveLength(1);
    const toggle = document.querySelector<HTMLInputElement>(
      ".target-track-toggle input",
    )!;
    await act(async () => toggle.click());
    expect(document.querySelector(".map-track")).toBeNull();
    await publish({ ...receiver });
    expect(document.querySelector(".map-track")).toBeNull();
    await act(async () => toggle.click());
    expect(document.querySelectorAll(".map-track path")).toHaveLength(1);
    await click("Freeze display");
    const heldPath = document
      .querySelector(".map-track path")
      ?.getAttribute("d");
    const moving =
      mode === "ADS-B"
        ? {
            ...receiver,
            adsb: {
              ...receiver.adsb!,
              targets: receiver.adsb!.targets.map((target) => ({
                ...target,
                latitude: 53,
                track: [...track, { latitude: 53, longitude: 13, timeMs: 200 }],
              })),
            },
          }
        : {
            ...receiver,
            ais: {
              ...receiver.ais!,
              targets: receiver.ais!.targets.map((target) => ({
                ...target,
                latitude: 53,
                track: [...track, { latitude: 53, longitude: 13, timeMs: 200 }],
              })),
            },
          };
    await publish(moving);
    expect(document.querySelector(".map-track path")?.getAttribute("d")).toBe(
      heldPath,
    );
    await click("Resume live display");
    expect(
      document.querySelector(".map-track path")?.getAttribute("d"),
    ).not.toBe(heldPath);
    // Restore the original positioned/unpositioned fixture for selection checks.
    await publish(
      mode === "ADS-B"
        ? {
            ...receiver,
            adsb: {
              ...receiver.adsb!,
              targets: receiver.adsb!.targets.map((target, index) => ({
                ...target,
                ...(index === 0
                  ? position
                  : { latitude: null, longitude: null }),
                track: index === 0 ? track : [],
              })),
            },
          }
        : {
            ...receiver,
            ais: {
              ...receiver.ais!,
              targets: receiver.ais!.targets.map((target, index) => ({
                ...target,
                ...(index === 0
                  ? position
                  : { latitude: null, longitude: null }),
                track: index === 0 ? track : [],
              })),
            },
          },
    );
    await act(async () =>
      document
        .querySelectorAll<HTMLButtonElement>(".decoder-record")[1]!
        .click(),
    );
    expect(document.querySelector(".map-target-selected")).toBeNull();
    await act(async () =>
      document
        .querySelector(".map-target")!
        .dispatchEvent(new MouseEvent("click", { bubbles: true })),
    );
    expect(
      document
        .querySelectorAll(".decoder-record")[0]
        ?.getAttribute("aria-pressed"),
    ).toBe("true");
    await click("Results");
    expect(document.querySelector(".target-plot")).toBeNull();
    await publish({ ...receiver });
    expect(document.querySelector(".target-plot")).toBeNull();
    const nextMode = mode === "ADS-B" ? "AIS" : "ADS-B";
    props = { ...props, mode: nextMode, configuredMode: nextMode };
    await render();
    expect(
      document.querySelector(".target-plot svg")?.getAttribute("aria-label"),
    ).toBe(`${nextMode} decoded positions: 1 positioned targets`);
    await click("Results");
    await click("Map & results");
    expect(document.querySelectorAll(".target-plot")).toHaveLength(1);
    expect(props.onApply).not.toHaveBeenCalled();
  },
);

it("freezes review data while ingest continues and clears it across generations", async () => {
  await render();
  await click("Freeze display");
  await publish({
    ...receiver,
    rds: { ...receiver.rds!, programmeService: "SECOND", validGroups: 8 },
  });
  expect(document.querySelector(".decoder-record strong")?.textContent).toBe(
    "FIRST",
  );
  expect(
    document.querySelector(".decoder-review-status")?.textContent,
  ).toContain("5 additional accepted groups");
  await publish({
    ...receiver,
    sessionGeneration: 2,
    rds: {
      ...receiver.rds!,
      programmeService: "NEW GENERATION",
      validGroups: 1,
    },
  });
  expect(document.querySelector(".decoder-record strong")?.textContent).toBe(
    "NEW GENERATION",
  );
  expect(document.querySelector(".decoder-state")?.textContent).toBe(
    "Live input",
  );
  expect(props.onApply).not.toHaveBeenCalled();
});

it("browsing does not configure and recording handoff does not configure", async () => {
  await render();
  const selector =
    document.querySelector<HTMLSelectElement>("#decoder-format")!;
  await act(async () => {
    selector.value = "APRS";
    selector.dispatchEvent(new Event("change", { bubbles: true }));
  });
  expect(props.onApply).not.toHaveBeenCalled();
  expect(document.querySelector(".decoder-record")).toBeNull();
  await click("Apply APRS");
  expect(props.onApply).toHaveBeenCalledExactlyOnceWith("APRS");
  await click("Open I/Q recording");
  expect(props.onOpenRecording).toHaveBeenCalledOnce();
  expect(props.onApply).toHaveBeenCalledOnce();
});

it("explains unavailable remote input and blocks applying while a recording is active", async () => {
  props = {
    ...props,
    mode: "OFF",
    configuredMode: "OFF",
    blockedReason: "Finish recording",
  };
  await render();
  const apply = [
    ...document.querySelectorAll<HTMLButtonElement>("button"),
  ].find((b) => b.textContent === "Apply WBFM")!;
  expect(apply.disabled).toBe(true);
  expect(document.body.textContent).toContain("Finish recording");
  props = { ...props, remote: true };
  await render();
  expect(document.body.textContent).toContain(
    "Remote audio/FFT does not provide the raw I/Q",
  );
  expect(props.onApply).not.toHaveBeenCalled();
});

it("does not pair a newly applying mode with the previous decoder publication", async () => {
  await render();
  await publish({
    ...receiver,
    lifecycle: "tuning",
    message: "Applying WBFM",
    sessionGeneration: 2,
  });
  expect(document.querySelector(".decoder-record")).toBeNull();
  expect(document.body.textContent).toContain(
    "Applying the decoder configuration",
  );
});

it("distinguishes stopped hardware settings from the last applied mode without repeatedly applying", async () => {
  receiver = {
    lifecycle: "connected",
    message: "Reception stopped",
    sessionGeneration: 2,
  };
  props = { ...props, configuredMode: "APRS", mode: "WBFM" };
  await render();
  expect(
    document.querySelector<HTMLSelectElement>("#decoder-format")?.value,
  ).toBe("APRS");
  expect(document.querySelector(".decoder-state")?.textContent).toBe(
    "Configured / idle",
  );
  expect(
    [...document.querySelectorAll("button")].some(
      (b) => b.textContent === "Apply APRS",
    ),
  ).toBe(false);
  expect(document.body.textContent).toContain("Configured for next start");
  expect(document.querySelector(".decoder-record")).toBeNull();
  expect(props.onApply).not.toHaveBeenCalled();
});

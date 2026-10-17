// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import {
  dataAcquisitionSummary,
  DecodedResults,
  ReceiverMetadataSummary,
} from "./DecodedResults";
import type {
  ReceiverController,
  ReceiverSnapshot,
} from "../radio/receiverController";
import { SYNTHETIC_DEMO_SESSION } from "../testing/syntheticTone";

it("does not label retained entries as current validated traffic when the packet counter or generation is zero/stale", () => {
  const snapshot = {
    sessionGeneration: 8,
    aprs: { counters: { validAx25Frames: 0 }, stations: Array(6).fill({}) },
  } as ReceiverSnapshot;
  expect(dataAcquisitionSummary(snapshot, "APRS")).toBe(
    "0 accepted packets this session · 0 retained stations",
  );
  snapshot.aprs!.counters.validAx25Frames = 2;
  expect(dataAcquisitionSummary(snapshot, "APRS")).toBe(
    "2 accepted packets this session · 6 retained stations",
  );
  snapshot.aprsWorker = { generation: 7 } as NonNullable<
    ReceiverSnapshot["aprsWorker"]
  >;
  expect(dataAcquisitionSummary(snapshot, "APRS")).toBe(
    "0 accepted packets this session · 0 retained stations",
  );
});

it("keeps RDS text in the collapsed dock and exposes no invented metadata for another source", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  let snapshot: ReceiverSnapshot = {
    lifecycle: "running",
    message: "Receiving",
    sessionGeneration: 1,
    session: {
      ...SYNTHETIC_DEMO_SESSION,
      source: "rtl-sdr",
      mode: "WBFM",
      sessionGeneration: 1,
    },
    rds: {
      validGroups: 4,
      pi: "1234",
      programmeService: "Test FM",
      radioText: "Broadcast text",
    },
  };
  const controller = {
    getSnapshot: () => snapshot,
    subscribe: () => () => undefined,
  } as unknown as ReceiverController;
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  try {
    await act(async () =>
      root.render(
        <ReceiverMetadataSummary
          controller={controller}
          mode="WBFM"
          source="rtl-sdr"
          active
        />,
      ),
    );
    expect(host.querySelector(".collapsed-metadata")?.textContent).toBe(
      "FM stereo reception: Checking stereo pilot… · Test FM · Broadcast text",
    );
    snapshot = {
      ...snapshot,
      session: { ...snapshot.session!, mode: "DAB" },
      dab: {
        state: "synchronized",
        message: "DAB",
        frameCount: 1,
        nullSymbolCount: 1,
        estimatedSnrDb: null,
        coarseFrequencyOffsetHz: null,
        ensemble: { id: 1, label: "Ensemble", shortLabel: "Ens" },
        programmeMetadata: { text: "Live DLS" },
      },
    };
    await act(async () =>
      root.render(
        <ReceiverMetadataSummary
          controller={controller}
          mode="DAB"
          source="rtl-sdr"
          active
        />,
      ),
    );
    expect(host.querySelector(".collapsed-metadata")?.textContent).toBe(
      "Ensemble · Live DLS",
    );
    await act(async () =>
      root.render(
        <ReceiverMetadataSummary
          controller={controller}
          mode="WBFM"
          source="hackrf"
          active
        />,
      ),
    );
    expect(host.textContent).toBe("");
  } finally {
    await act(async () => root.unmount());
    host.remove();
    vi.unstubAllGlobals();
  }
});

it.each([
  [undefined,"Checking stereo pilot…","running"],
  ["stereo","Stereo · stable pilot","running"],
  ["mono","Mono · no stable stereo pilot","running"],
  ["intermittent","Intermittent pilot","running"],
  ["stereo","Not receiving","connected"],
] as const)("uses the same %s reception summary in expanded and collapsed views", async (status,text,lifecycle) => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT",true);
  const snapshot:ReceiverSnapshot={lifecycle,message:"Receiving",sessionGeneration:1,
    session:{...SYNTHETIC_DEMO_SESSION,source:"rtl-sdr",mode:"WBFM"},fmStereoReception:status};
  const controller={getSnapshot:()=>snapshot,subscribe:()=>()=>{}} as unknown as ReceiverController;
  const host=document.createElement("div");document.body.append(host);const root=createRoot(host);
  try {
    await act(async()=>root.render(<>
      <DecodedResults receiver={snapshot} source="rtl-sdr" mode="WBFM" volume={.5} />
      <ReceiverMetadataSummary controller={controller} source="rtl-sdr" mode="WBFM" active />
    </>));
    expect(host.querySelector('[aria-label="FM stereo reception"]')?.textContent?.trim()).toBe(`FM stereo reception: ${text}`);
    expect(host.querySelector('.collapsed-metadata')?.textContent).toBe(`FM stereo reception: ${text}`);
  } finally {await act(async()=>root.unmount());host.remove();vi.unstubAllGlobals();}
});

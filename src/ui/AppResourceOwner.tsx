import { useEffect, useState, type ReactNode } from "react";
import { AnalysisPipeline } from "../dsp/analysisPipeline";
import { ReceiverController } from "../radio/receiverController";
import type { IqRecording } from "../radio/iqRecording";
import type { VerifiedUsrpB205Image } from "../radio/usrpB205Images";
import type { VerifiedUsrpB205Firmware } from "../radio/usrpB205Firmware";
import { lazyUsbBackend } from "../radio/lazyUsbBackend";
import { AIRSPY_USB_FILTER } from "../radio/airspySettings";
import { BLADERF_USB_FILTER } from "../radio/bladerfProtocol";
import { HACKRF_USB_FILTER } from "../radio/hackrfProtocol";

import { createUsrpb205Backend } from "../radio/usrpB205Backend";
import { createUsrpB205WorkerSession } from "../radio/usrpB205WorkerSession";
import { createRtlSdrBackend } from "../radio/rtlSdrBackend";
import { SyntheticBackend } from "../radio/syntheticBackend";
import { ReplayBackend } from "../radio/replayBackend";
import { browserTestConfig } from "../testing/browserTestBridge";
import {
  createLocalUsrpB205NoOsDriver,
  localUsrpB205NoOsDriverAvailable,
} from "../radio/usrpB205LocalNoOsDriver";

export interface AppRuntime {
  analysis: AnalysisPipeline;
  controller: ReceiverController;
  replayRef: { current: IqRecording | undefined };
  usrpImageRef?: { current: VerifiedUsrpB205Image | undefined };
  usrpFirmwareRef?: { current: VerifiedUsrpB205Firmware | undefined };
}

interface AppResourceOwnerProps {
  createAnalysis?: () => AnalysisPipeline;
  children: (runtime: AppRuntime) => ReactNode;
}

const createDefaultAnalysis = () => new AnalysisPipeline();

/** Creates effect-owned resources so every StrictMode setup has a matching cleanup. */
export function AppResourceOwner({
  createAnalysis = createDefaultAnalysis,
  children,
}: AppResourceOwnerProps) {
  const [runtime, setRuntime] = useState<AppRuntime>();

  useEffect(() => {
    const analysis = createAnalysis();
    const testConfig = browserTestConfig();
    const replayRef: AppRuntime["replayRef"] = { current: undefined };
    const usrpImageRef: NonNullable<AppRuntime["usrpImageRef"]> = {
      current: testConfig?.usrpB205Dependencies?.image,
    };
    const usrpFirmwareRef: NonNullable<AppRuntime["usrpFirmwareRef"]> = {
      current: testConfig?.usrpB205Dependencies?.firmware,
    };
    const controller = new ReceiverController((events, options, generation) =>
      options.source === "synthetic"
        ? new SyntheticBackend(events, analysis, generation)
        : options.source === "replay"
          ? new ReplayBackend(
              events,
              analysis,
              replayRef.current ??
                (() => {
                  throw new Error(
                    "Load a valid I/Q recording and JSON sidecar before starting replay.",
                  );
                })(),
              generation,
            )
          : options.source === "airspy"
            ? lazyUsbBackend(async () => new (await import("../radio/airspyBackend")).AirspyBackend(events, analysis, generation, testConfig?.airspyDependencies), AIRSPY_USB_FILTER, testConfig?.airspyDependencies?.usb)
          : options.source === "hackrf"
            ? lazyUsbBackend(async () => (await import("../radio/hackrfBackend")).createHackrfBackend(events, analysis, generation, testConfig?.hackrfDependencies), HACKRF_USB_FILTER, testConfig?.hackrfDependencies?.usb)
            : options.source === "bladerf"
              ? lazyUsbBackend(async () => (await import("../radio/bladerfBackend")).createBladeRfBackend(events, analysis, generation, testConfig?.bladerfDependencies), BLADERF_USB_FILTER, testConfig?.bladerfDependencies?.usb)
              : options.source === "usrp-b205"
                ? createUsrpb205Backend(events, analysis, generation, {
                    ...testConfig?.usrpB205Dependencies,
                    image:
                      testConfig?.usrpB205Dependencies?.image ??
                      usrpImageRef.current,
                    firmware:
                      testConfig?.usrpB205Dependencies?.firmware ??
                      usrpFirmwareRef.current,
                    createAd9364Driver:
                      testConfig?.usrpB205Dependencies?.createAd9364Driver ??
                      (localUsrpB205NoOsDriverAvailable()
                        ? createLocalUsrpB205NoOsDriver
                        : undefined),
                    createWorkerSession:
                      testConfig?.usrpB205Dependencies?.createWorkerSession ??
                      (!testConfig && localUsrpB205NoOsDriverAvailable()
                        ? createUsrpB205WorkerSession
                        : undefined),
                  })
                : createRtlSdrBackend(
                    events,
                    analysis,
                    generation,
                    options.channelFrequencyHz,
                    testConfig?.rtlDependencies,
                  ),
    );
    const owned = {
      analysis,
      controller,
      replayRef,
      usrpImageRef,
      usrpFirmwareRef,
    };
    setRuntime(owned);
    return () => {
      void controller.disconnect().finally(() => analysis.dispose());
    };
  }, [createAnalysis]);

  return runtime ? children(runtime) : null;
}

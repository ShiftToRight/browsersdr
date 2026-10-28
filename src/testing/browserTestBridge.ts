import type { HackrfBackendDependencies } from "../radio/hackrfBackend";
import type { RtlSdrBackendDependencies } from "../radio/rtlSdrBackend";
import type { BladeRfBackendDependencies } from "../radio/bladerfBackend";
import type { Usrpb205BackendDependencies } from "../radio/usrpB205Backend";

export interface BrowserSdrTestConfig {
  airspyDependencies?: import("../radio/airspyBackend").AirspyBackendDependencies;
  hackrfDependencies?: HackrfBackendDependencies;
  rtlDependencies?: RtlSdrBackendDependencies;
  bladerfDependencies?: BladeRfBackendDependencies;
  usrpB205Dependencies?: Usrpb205BackendDependencies;
}

export interface BrowserSdrTestRuntime {
  unmount(): void;
}

declare global {
  interface Window {
    __BROWSERSDR_TEST_CONFIG__?: BrowserSdrTestConfig;
    __BROWSERSDR_TEST_RUNTIME__?: BrowserSdrTestRuntime;
  }
}

export function browserTestConfig(): BrowserSdrTestConfig | undefined {
  return new URLSearchParams(window.location.search).get("browser-test") === "1"
    ? window.__BROWSERSDR_TEST_CONFIG__
    : undefined;
}

export function exposeBrowserTestUnmount(unmount: () => void): void {
  if (new URLSearchParams(window.location.search).get("browser-test") === "1") {
    window.__BROWSERSDR_TEST_RUNTIME__ = { unmount };
  }
}

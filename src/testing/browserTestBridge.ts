import type { HackrfBackendDependencies } from "../radio/hackrfBackend";
import type { RtlSdrBackendDependencies } from "../radio/rtlSdrBackend";
import type { BladeRfBackendDependencies } from "../radio/bladerfBackend";

export interface BrowserSdrTestConfig {
  hackrfDependencies?: HackrfBackendDependencies;
  rtlDependencies?: RtlSdrBackendDependencies;
  bladerfDependencies?: BladeRfBackendDependencies;
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

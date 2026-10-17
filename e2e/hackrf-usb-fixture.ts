import type { Page } from "@playwright/test";
import { readFile } from "node:fs/promises";
import ts from "typescript";

export async function installHackrfUsb(
  page: Page,
  failure = false,
  one = false,
  nativeRateHz = 0,
) {
  // Inject the same scriptable USB fixture into dev and built pages. The app still
  // runs its actual protocol, transport, backend, DSP and recording pipeline.
  const fixture = ts.transpileModule(
    (await readFile("src/testing/hackrfUsbFixture.ts", "utf8")).replace(
      /^export /gm,
      "",
    ),
    {
      compilerOptions: {
        target: ts.ScriptTarget.ES2022,
        module: ts.ModuleKind.None,
      },
    },
  ).outputText;
  const oneFixture = one
    ? ts.transpileModule(
        (await readFile("src/testing/hackrfOneUsbFixture.ts", "utf8"))
          .replace(/^import .*;$/gm, "")
          .replace(/^export /gm, ""),
        {
          compilerOptions: {
            target: ts.ScriptTarget.ES2022,
            module: ts.ModuleKind.None,
          },
        },
      ).outputText
    : "";
  await page.addInitScript({
    content: `${fixture}\n${oneFixture}\nwindow.__makeHackrfUsb = () => new ${one ? "FakeHackrfOneUsb" : "FakeHackrfUsb"}(0x0110);`,
  });
  await page.addInitScript(
    ({ unsupported, one, nativeRateHz }) => {
      const device = (
        window as unknown as {
          __makeHackrfUsb(): {
            deviceVersionSubminor: number;
            radio: Map<number, bigint>;
            pendingReads: unknown[];
            reads: { settled: boolean }[];
            lifecycle: string[];
            closeFailures: number;
            deliver(bytes: Uint8Array): void;
          };
        }
      ).__makeHackrfUsb();
      if (unsupported) device.deviceVersionSubminor = 2;
      const state = { chooserCalls: 0, gesture: false, device };
      (window as unknown as { __hackrf: typeof state }).__hackrf = state;
      const usb = {
        requestDevice: () => {
          state.chooserCalls++;
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
      ).__BROWSERSDR_TEST_CONFIG__ = { hackrfDependencies: { usb } };
      const bytes = new Uint8Array(65_536);
      for (let n = 0; n < bytes.length / 2; n++) {
        bytes[n * 2] = Math.round(60 * Math.cos(2 * Math.PI * n * 0.125));
        bytes[n * 2 + 1] = Math.round(60 * Math.sin(2 * Math.PI * n * 0.125));
      }
      let generatedSamples = 0;
      let generationAt = performance.now();
      window.setInterval(
        () => {
          if (nativeRateHz) {
            if (device.radio.get(0) !== 1n) {
              generationAt = performance.now();
              generatedSamples = 0;
            } else {
              const target =
                ((performance.now() - generationAt) * nativeRateHz) / 1000;
              while (
                device.pendingReads.length &&
                generatedSamples + bytes.length / 2 <= target
              ) {
                device.deliver(bytes);
                generatedSamples += bytes.length / 2;
              }
            }
          } else if (device.radio.get(0) === 1n && device.pendingReads.length)
            if (one) {
              device.deliver(bytes);
              device.deliver(bytes);
              device.deliver(bytes.subarray(0, 60_928));
            } else device.deliver(bytes);
          // The test log is also bounded across repeated retunes.
          while (device.reads.length > 64 && device.reads[0]?.settled)
            device.reads.shift();
        },
        one ? 10 : 20,
      );
    },
    { unsupported: failure, one, nativeRateHz },
  );
}

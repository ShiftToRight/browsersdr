import { afterEach, expect, it, vi } from "vitest";
import { textModemConfiguration } from "../textmodem/settings";

afterEach(() => vi.unstubAllGlobals());
it.each(["RTTY", "PSK31", "NAVTEX", "ACARS", "WEFAX", "SSTV", "CW-TEXT"] as const)(
  "%s worker returns borrowed credits even on rejected input and acknowledges final publication",
  async (mode) => {
    const port = {
      postMessage: vi.fn(),
      close: vi.fn(),
      onmessage: undefined as unknown as (event: MessageEvent) => void,
    };
    vi.stubGlobal("self", port);
    vi.resetModules();
    await import("../workers/textModem.worker");
    port.onmessage({
      data: {
        type: "configure",
        configuration: textModemConfiguration(mode, undefined, 1_024_000, 3),
      },
    } as MessageEvent);
    port.postMessage.mockClear();
    const I = new Float32Array(2),
      Q = new Float32Array(1);
    port.onmessage({
      data: {
        type: "samples",
        generation: 3,
        sequence: 42,
        firstSampleIndex: 0,
        I,
        Q,
      },
    } as MessageEvent);
    expect(
      port.postMessage.mock.calls.map(([message]) => message.type),
    ).toEqual(["error", "consumed"]);
    expect(port.postMessage.mock.calls[1]?.[0]).toMatchObject({
      generation: 3,
      sequence: 42,
      I,
      Q,
    });
    port.postMessage.mockClear();
    port.onmessage({
      data: {
        type: "samples",
        generation: 2,
        sequence: 43,
        firstSampleIndex: 0,
        I,
        Q,
      },
    } as MessageEvent);
    expect(port.postMessage.mock.calls[0]?.[0]).toMatchObject({
      type: "consumed",
      generation: 2,
      sequence: 43,
    });
    port.postMessage.mockClear();
    port.onmessage({
      data: { type: "flush", generation: 3, sequence: 44 },
    } as MessageEvent);
    expect(
      port.postMessage.mock.calls.map(([message]) => message.type),
    ).toEqual(["snapshot", "flushed"]);
  },
);

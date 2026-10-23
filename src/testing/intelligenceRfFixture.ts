/** Generated RF only. Used by explicit browser-test pages; no hardware or catalogue. */
export function installIntelligenceRfFixture(
  multiplex: Float32Array,
  amplitude: () => number = () => 0.65,
): void {
  let phase = 0,
    narrowPhase = 0,
    cursor = 0,
    random = 4271;
  let rate = 1_024_000,
    center = 100e6,
    nextAt = 0,
    closed = false;
  Object.defineProperty(navigator, "usb", { configurable: true, value: {} });
  window.__BROWSERSDR_TEST_CONFIG__ = {
    rtlDependencies: {
      createSourceProvider: (permission, capture) => ({
        get: async () => {
          permission();
          closed = false;
          return {
            setSampleRate: async (value) => {
              rate = value;
              return value;
            },
            setCenterFrequency: async (value) => {
              center = value;
              return value;
            },
            setParameter: async <V>(_parameter: string, value: V) => value,
            startReceiving: async () => {
              nextAt = performance.now();
            },
            close: async () => {
              closed = true;
            },
            readSamples: (count) => {
              const frequency = center;
              nextAt =
                Math.max(nextAt, performance.now()) + (count / rate) * 1000;
              return new Promise((resolve) =>
                setTimeout(
                  () => {
                    const I = new Float32Array(count),
                      Q = new Float32Array(count),
                      bytes = new Uint8Array(count * 2);
                    const level = amplitude();
                    const main =
                      Math.abs(100_125_000 - frequency) < rate * 0.42;
                    const narrow =
                      Math.abs(99_770_000 - frequency) < rate * 0.42;
                    for (let n = 0; n < count; n++) {
                      const sample =
                        multiplex[
                          Math.floor((cursor++ * 336_000) / rate) %
                            multiplex.length
                        ]!;
                      phase +=
                        (2 *
                          Math.PI *
                          (100_125_000 - frequency + 75_000 * sample)) /
                        rate;
                      narrowPhase +=
                        (2 * Math.PI * (99_770_000 - frequency)) / rate;
                      random = (Math.imul(random, 1664525) + 1013904223) >>> 0;
                      const noise = (random / 0x80000000 - 1) * 0.003;
                      I[n] =
                        (main && !closed ? level * Math.cos(phase) : 0) +
                        (narrow && !closed ? 0.15 * Math.cos(narrowPhase) : 0) +
                        noise;
                      Q[n] =
                        (main && !closed ? level * Math.sin(phase) : 0) +
                        (narrow && !closed ? 0.15 * Math.sin(narrowPhase) : 0) -
                        noise;
                      bytes[2 * n] = Math.max(
                        0,
                        Math.min(255, Math.round(I[n]! * 128 + 127.5)),
                      );
                      bytes[2 * n + 1] = Math.max(
                        0,
                        Math.min(255, Math.round(Q[n]! * 128 + 127.5)),
                      );
                    }
                    capture(bytes.buffer);
                    resolve({ I, Q, frequency });
                  },
                  Math.max(0, nextAt - performance.now()),
                ),
              );
            },
          };
        },
      }),
    },
  };
}

# AD9364 receive-only WebAssembly driver

BrowserSDR ships a constrained WebAssembly build of Analog Devices' no-OS
AD9361-family driver. BrowserSDR's own licence is independent from this
third-party BSD-3-Clause component.

## Provenance

- Upstream: <https://github.com/analogdevicesinc/no-OS>
- Commit: `42d9893169f57b10c3d249a98633051e9ff037be`
- Upstream files: the `src/ad9361`, `src/include`, and `src/util` files retained
  here, each with its original copyright/licence header.
- BrowserSDR files: `src/bridge.c` and the B205-specific changes in
  `src/baseline.inc` provide the narrow receive-only ABI and board profile.
- Build: `scripts/build-usrp-b205-no-os.sh` with Emscripten 4.0.22 from emsdk
  commit `e566f7bdcc7735f44037911c24b87a58a3c93145`; Emscripten is an explicit
  maintainer dependency, not a runtime dependency.
- Reviewed output SHA-256: JS
  `630273ef7c483e2c11dd31143e4d78bcf50a1f22e5e270860578331500cd7286`,
  WASM `2eae629bf4f295c49b1d27fb8f0a4edf39e71e4083094cc937753250eb624598`.

The exported ABI contains initialization and RX rate, bandwidth, LO, input,
gain-mode, ENSM and readback operations. It exports no TX API. The surrounding
TypeScript adapter additionally prevents arbitrary register or endpoint access.

The full applicable BSD terms are in `LICENSE` and reproduced in the top-level
`THIRD_PARTY_NOTICES.md`. No use of Analog Devices' name or contributors for
endorsement is permitted.

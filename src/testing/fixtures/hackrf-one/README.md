# HackRF One source and wire evidence

Experimental receive profile: official v2026.01.3 / USB API 0x0110, board IDs 2 (pre-r9) and 4 (r9+), signed interleaved I8/Q8 at nominal 9.6 MS/s. The host channel filter produces 2.4 MS/s; original recordings retain native bytes. No physical One reception is claimed.

`source-evidence.json` pins inspected upstream files and archive hashes. The annotated release tag was independently resolved to commit `1cfe7dfe98d333450217d50e3f3a1ad0702e000f` on 2026-10-13. The source inspection date is not a publication date. Upstream host/firmware source remains external and is not included in the application.

`wire-oracle.json` was produced by compiling the **actual pinned libhackrf implementation** with an intercepted libusb control-transfer layer. It records RX/OFF, rate plus analog-filter selection, frequency, gain, amplifier/antenna/trigger OFF, and bias-tee OFF/RX defaults. It proves request bytes from the upstream host setters, not hardware responses, analog filtering or RF reception. One tests compare the application requests against these vectors independently of the state model.

Reproduce with a local copy of the exact upstream archive and libusb v1.0.29 header (hashes checked before compilation):

```sh
python3 scripts/verify-hackrf-one-oracle.py /absolute/path/to/hackrf-1cfe7dfe98d333450217d50e3f3a1ad0702e000f /absolute/path/to/libusb.h
```

Requirements: Python 3, a C compiler supporting function/data sections and linker garbage collection, pthread/math headers and libraries. The harness opens no USB device, performs no network request and writes only temporary build files. It prints JSON without changing fixtures. All vendor runtime source is independently implemented from wire facts; the generated fixtures contain measurements of the host calls, not copied vendor implementation. The script's minimal test shim supplies acknowledgement responses and a descriptor API; that shim is not a firmware emulator.

`FakeHackrfOneUsb` separately models pending OFF versus applied RX settings, conventional control requests, identity, bulk scheduling and failures. Pro FPGA/image/register commands stall. Descriptor checks, clock/sample orientation, filter/decoder output and metadata/replay are tested through their own software boundaries. Current One status stays experimental; hardware/firmware/API/browser/rate/mode field results must remain separately attributed.

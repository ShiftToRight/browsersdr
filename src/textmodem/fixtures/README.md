# Independent reference material

## SSTV encoder reference — generated 2026-10-15

`sstv-m2-reference-bars.png` is an original four-bar red/green/blue/white 160×256 test image. Unmodified PySSTV `d998fad154d3e6ad2d73af5add49beec0d2ab59f` generated Martin M2 audio at 8 kHz/16-bit, bundled Python with Pillow/NumPy, Python random seed 42. `sstv-m2-reference-prefix.wav` retains exactly the first `ceil((0.910 + 6 × 0.226798 + 0.010) × 8000)` samples: the full VIS header, six complete rows and the start of the seventh. It deliberately cannot establish full-frame completion.

`sstv-m2-reference-analytic.wav` is a derived two-channel PCM16 WAV: channel 1 I, channel 2 Q, from a NumPy FFT Hilbert transform (8,192 zero samples padded at each edge, DC/Nyquist retained, positive bins doubled, negative bins zero), scaled by 0.55 and quantized to int16. Tests interpolate this generated analytic input into RF with an explicit offset. This verifies independent encoder compatibility, not hardware reception, real SSB acquisition, fading or a reference receiver. Exact hashes and provenance are in `sstv-m2-reference.json`. Generator license: `third_party/pysstv/LICENSE.txt` (MIT); no PySSTV code ships in application bundles.

## Independent ACARS audio

`acarsdec-test.wav` is the unchanged `test.wav` from [f00b4r0/acarsdec](https://github.com/f00b4r0/acarsdec/blob/36f1ccc6c3029d536364dce94aa7665029ad359a/test.wav), pinned revision `36f1ccc6c3029d536364dce94aa7665029ad359a`, inspected 2026-10-15. Original recording date and receiver environment are unknown. This is independently supplied modem audio, not BrowserSDR physical reception or independent wideband I/Q.

SHA-256: `4ea48bb633fd26f4eff47c618cb2bdff6b2336dfd3f19a23722454ecd0531519`. WAV: 12,000 sample/s, four channels, signed 16-bit little-endian, 51,689 frames. Copyright and GPL-2.0-only terms are retained in [the upstream license](../../../third_party/acarsdec/LICENSE.md) and [reference notes](../../../third_party/acarsdec/README.md). Used by tests only, never imported by runtime code.

Reference comparison: unmodified upstream C decoder, optional interfaces disabled, compiled with GCC 16.2.1. First WAV channel expanded fourfold to 48 ksample/s, embedded in a positive AM envelope as CU8 I/Q, then decoded with `acarsdec -c 131.55 --output full:file:path=... --iqfile file=...,sr=48000 131.55`. This generated AM embedding is not an RF recording. The first nonempty reference result reports address `F-GTAE`, mode `G`, label `H1`, block `3`, NAK, message number `D65C`, flight `AF7728`, and body beginning `#DFB00000/V206,05,124,183,02,00,00000/`. BrowserSDR preserves the received message number/flight prefix as raw text rather than claiming a higher-layer application parser. ACK-only blocks without STX are retained with empty text; ETB blocks are marked incomplete/continuing.

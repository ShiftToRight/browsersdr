# BrowserSDR

Software-defined radio in your browser: live spectrum and waterfall, audio and digital decoding, I/Q recording, replay, and field surveys.

**Source version: 1.6.1.** Stable desktop support covers RTL-SDR and HackRF Pro on Chrome. About shows the installed version and exact build; website deployment is tracked separately. See [changes and version policy](CHANGELOG.md).

**Stable desktop receivers:** RTL-SDR and HackRF Pro, using WebUSB over HTTPS or localhost. Chrome is the validated desktop browser baseline. Other Chromium browsers, bladeRF/USRP, remote receivers and unverified mode combinations remain available for further testing and community feedback; experimental hardware/rate labels still apply. HackRF One is available experimentally through the shared HackRF One / Pro selector: USB API 0x0110 (official v2026.01.3 baseline), native 9.6 MS/s filtered to a 2.4 MS/s channel. One has source-based protocol and simulated browser coverage; physical One reception remains unverified. A hardware-free demo and replay are available. WebGPU rendering has a Canvas2D fallback. Help and the wiki distinguish tested configurations from feature availability.

HackRF gains apply live, and Pro sample rates can switch during reception. An active recording finishes before its settings change; rate transitions include a brief reception gap.

The DSP filter uses a standard-SIMD compatibility kernel when the browser cannot compile relaxed SIMD, allowing the interface to load on affected Safari configurations.

**Images and Morse (local development):** WEFAX receives IOC 288/576 grayscale weather charts with selectable line rate/shift, automatic APT/phasing or manual start. SSTV supports Martin M1/M2 with checked VIS parity or manual line synchronization; other SSTV formats are not yet implemented. Decoder shows progressive images, retains one bounded raster and exports PNG plus input-clock metadata, with display alignment/slant correction. CW + text is an opt-in mode with the existing CW audio monitor, adjustable WPM/threshold and tentative Morse transcription; ordinary CW listening remains available. All three support compatible live I/Q and replay, favorites and settings links. Generated vectors and independent PySSTV encoder audio are software evidence; independent received WEFAX/CW and physical off-air acceptance remain open.

**Text decoders (local development):** RTTY includes DWD 50-baud/450-Hz and amateur 45.45-baud/170-Hz presets, configurable polarity/framing and fine tuning. BPSK31 receives 31.25-baud Varicode text. NAVTEX/SITOR-B uses CCIR476 phasing and delayed-copy FEC to assemble framed marine messages. Single-channel VHF ACARS requires CRC and odd parity. All four use bounded workers for live I/Q and compatible replay, show tuning/integrity status in Decoder, and export text/JSON with sample-clock provenance. RTTY/BPSK31 have no checksum; text is tentative. Independent ACARS modem audio is tested; independent HF reference and physical off-air acceptance remain open. Suitable HF/LF input and antenna are required; RTL Q-branch support and processed remote audio remain separate work.

**Mode selection:** The short Mode dropdown keeps common listening modes close to tuning. More modes opens a searchable decoder chooser with categories and an explicit Use mode action. Pin up to seven quick choices; the current mode stays visible even when unpinned. Pins stay in this browser.

**Audio recorder & rewind (local development):** Open Audio & decode → Audio recorder & rewind to record decoded audio as stereo PCM16 WAV, up to two minutes per clip. Enable the optional 60-second rolling buffer to replay or save recent audio while reception continues. Recordings use audio before the volume control; live sound is muted while rewind plays. Source/tuning/programme changes and detected gaps stop the clip and clear rewind; completed replay retains rewind until the next source. Download before closing; these clips stay in memory and are separate from I/Q recordings. Remote audio exports contain processed server audio.

**Installable app (local development):** Settings offers Install BrowserSDR app when your browser makes installation available. The app launches in its own window with the same receiver permissions. Opening it requires internet access; offline startup is separate work. Use one tab or app window per physical receiver.

**Decoder maps:** Geographic views use detailed local geography automatically, with clearer coastlines, rivers, boundaries and city labels. Zoom with the scroll wheel, +/− controls or keys, drag to pan, and use Fit targets to reset the view. Map data loads when needed.

**Appearance:** Choose Midnight Observatory, Amber Field Deck or Vice Afterglow from Settings → Theme. Your choice stays in this browser and applies while receiving or replaying.

**Community tests:** Compatibility & tests in the ? menu includes version tabs, a shared hardware × decoder matrix, separate platform checks, and exact-build engine evidence. Report only the functions you tested; duration-qualified reports contribute immediately, and two distinct participation tokens confirm a compatible feature cell. Tokens help deduplicate reports; they do not prove independent physical tests. Live reporting needs the [optional collector and proxy routes](deploy/report-service/README.md); development builds can download reports for review.

Unchanged features can retain earlier compatibility evidence through explicitly recorded build equivalence and integration checks. The matrix labels it **carried**, shows its original build/dates/expiry, and keeps fresh counts separate. Relevant issues, withdrawals and expiry still apply; changed processing or display paths need their own checks. See the [carry-forward procedure](deploy/report-service/README.md#carrying-unchanged-feature-evidence-between-releases).

![BrowserSDR receiving WBFM with an RTL-SDR, showing the spectrum, waterfall and RDS station data](assets/receiver.jpg)

[Open BrowserSDR](https://browsersdr.com) · [Wiki](https://github.com/cybearde/browsersdr/wiki) · [Getting started](https://github.com/cybearde/browsersdr/wiki/Getting-started) · [Build & test](https://github.com/cybearde/browsersdr/wiki/Development) · [Issues](https://github.com/cybearde/browsersdr/issues)

[PolyForm Perimeter 1.0.1](LICENSE) · [Third-party notices](THIRD_PARTY_NOTICES.md)

Public Atlas Search uses station headers and loads matching references on demand. Station and reference continuation retain the same filters and catalog generation; changed or expired cursors require refreshing Search. Exact UUID links and deliberate receiver preview/apply remain available beyond the first reference page.

The optional Band guide between spectrum and waterfall offers a common CEPT European reference and country profiles grouped by region. Selected intervals include national differences and source editions in inspect-only details; uncovered ranges stay explicit. The compact strip and profile choice are saved per browser.

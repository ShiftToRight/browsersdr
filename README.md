# BrowserSDR

Software-defined radio in your browser: live spectrum and waterfall, audio and digital decoding, I/Q recording, replay, and field surveys.

**Source version: 1.0.1.** Stable desktop support covers RTL-SDR and HackRF Pro on Chrome. About shows the installed version and exact build; website deployment is tracked separately. See [changes and version policy](CHANGELOG.md).

**Stable desktop receivers:** RTL-SDR and HackRF Pro, using WebUSB over HTTPS or localhost. Chrome is the validated desktop browser baseline. Other Chromium browsers, bladeRF/USRP, remote receivers and unverified mode combinations remain available for further testing and community feedback; experimental hardware/rate labels still apply. A hardware-free demo and replay are available. WebGPU rendering has a Canvas2D fallback. Help and the wiki distinguish tested configurations from feature availability.

**Community tests:** Compatibility & tests in the ? menu includes version tabs, a shared hardware × decoder matrix, separate platform checks, and exact-build engine evidence. Report only the functions you tested; two qualifying independent positives require review before confirmation. Live reporting needs the [optional collector and proxy routes](deploy/report-service/README.md); development builds can download reports for review.

![BrowserSDR receiving WBFM with an RTL-SDR, showing the spectrum, waterfall and RDS station data](assets/receiver.jpg)

[Open BrowserSDR](https://browsersdr.com) · [Wiki](https://github.com/cybearde/browsersdr/wiki) · [Getting started](https://github.com/cybearde/browsersdr/wiki/Getting-started) · [Build & test](https://github.com/cybearde/browsersdr/wiki/Development) · [Issues](https://github.com/cybearde/browsersdr/issues)

[PolyForm Perimeter 1.0.1](LICENSE) · [Third-party notices](THIRD_PARTY_NOTICES.md)

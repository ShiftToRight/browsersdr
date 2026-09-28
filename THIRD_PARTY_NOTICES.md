# Third-party notices

## Browser libraries

BrowserSDR bundles `@jtarrio/webrtlsdr` 3.0.6 and `@jtarrio/signals`
0.10.1 under the Apache License 2.0. It also bundles React 19.2.8,
React DOM 19.2.8 and fflate 0.8.3 under the MIT License. The corresponding
licence files are retained with the pinned packages used to build the release.
The Apache License 2.0 text is available at
<https://www.apache.org/licenses/LICENSE-2.0> and the MIT licence text at
<https://opensource.org/license/mit>.

## Analog Devices no-OS AD9361/AD9364 driver

BrowserSDR includes a receive-only WebAssembly build from Analog Devices no-OS
commit `42d9893169f57b10c3d249a98633051e9ff037be`, plus a BrowserSDR-specific
bridge and B205 receive profile. The exact source closure and reproducible build
instructions are retained under `third_party/adi-no-os/`. This component is
separate from, and does not determine, the licence chosen for BrowserSDR.

Copyright 2013-2026 Analog Devices, Inc.

Redistribution and use in source and binary forms, with or without
modification, are permitted provided that the following conditions are met:

1. Redistributions of source code must retain the above copyright notice,
   this list of conditions and the following disclaimer.

2. Redistributions in binary form must reproduce the above copyright notice,
   this list of conditions and the following disclaimer in the documentation
   and/or other materials provided with the distribution.

3. Neither the name of Analog Devices, Inc. nor the names of its contributors
   may be used to endorse or promote products derived from this software without
   specific prior written permission.

THIS SOFTWARE IS PROVIDED BY ANALOG DEVICES, INC. “AS IS” AND ANY EXPRESS OR
IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE IMPLIED WARRANTIES OF
MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE DISCLAIMED. IN NO
EVENT SHALL ANALOG DEVICES, INC. BE LIABLE FOR ANY DIRECT, INDIRECT,
INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL DAMAGES (INCLUDING, BUT NOT
LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR SERVICES; LOSS OF USE, DATA, OR
PROFITS; OR BUSINESS INTERRUPTION) HOWEVER CAUSED AND ON ANY THEORY OF
LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY, OR TORT (INCLUDING
NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE OF THIS SOFTWARE,
EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.

## Emscripten runtime and musl libc

The AD9364 JavaScript/WebAssembly artifact is generated with Emscripten 4.0.22
and includes applicable Emscripten runtime and musl libc portions.

Copyright (c) 2010-2014 Emscripten authors, see AUTHORS file.

Permission is hereby granted, free of charge, to any person obtaining a copy of
this software and associated documentation files (the "Software"), to deal in
the Software without restriction, including without limitation the rights to
use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of
the Software, and to permit persons to whom the Software is furnished to do so,
subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.

Copyright © 2005-2020 Rich Felker, et al.

Permission is hereby granted, free of charge, to any person obtaining a copy of
this software and associated documentation files (the "Software"), to deal in
the Software without restriction, including without limitation the rights to
use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of
the Software, and to permit persons to whom the Software is furnished to do so,
subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.

## Nuand bladeRF hosted FPGA images

BrowserSDR does not redistribute Nuand FPGA bitstreams. It links users to the
official versioned Nuand downloads and accepts a local `.rbf` import for
volatile device configuration. The supported xA4 source URLs, exact lengths,
versions and SHA-256 checksums are recorded in `src/radio/bladerfImages.ts`.
The original images and release notes are published at
<https://www.nuand.com/fpga_images/>.

## Ettus Research USRP B2xx firmware and FPGA images

BrowserSDR does not redistribute the pinned Ettus FX3 firmware or FPGA image.
It links to immutable official archives, accepts explicit local import, verifies
exact sizes and SHA-256 digests, and writes the images only to volatile device
RAM. Their exact UHD source, archive and member identities are recorded in
`public/assets/usrp-b205/uhd-4.9.0.0/` and the USRP protocol contract.

## DAB-Radio reference implementation

The DAB carrier mapping, puncturing and equal-error-protection constants in
`src/dab/dabChannelCoding.ts` and `src/dab/dabModeI.ts` are adapted from
[DAB-Radio](https://github.com/williamyang98/DAB-Radio), revision
`0a09ba34a40286cf77e0c48aa47cac64b86341ef`. The PAD and MOT reference
parsers in that revision were also consulted when implementing
`src/dab/dabPad.ts` and `src/dab/dabMot.ts`, alongside the ETSI specifications.

MIT License

Copyright (c) 2022 William Yang

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.

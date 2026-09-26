# Third-party notices

## Nuand bladeRF hosted FPGA images

BrowserSDR does not redistribute Nuand FPGA bitstreams. It links users to the
official versioned Nuand downloads and accepts a local `.rbf` import for
volatile device configuration. The supported xA4 source URLs, exact lengths,
versions and SHA-256 checksums are recorded in `src/radio/bladerfImages.ts`.
The original images and release notes are published at
<https://www.nuand.com/fpga_images/>.

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

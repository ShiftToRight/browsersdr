# Local UI fonts

Unmodified Google Fonts WOFF2 files for the existing Manrope 400/500/600/700 and IBM Plex Mono 400/500 styles. All supplied Unicode subsets and `font-display: swap` are retained. Local URLs remove an external stylesheet/font dependency from page loading; no font outlines or names are modified.

`sources.json` records retrieval time, exact Google Fonts source URLs and SHA-256 hashes, with pinned upstream license sources. `fonts.css` preserves the supplied face/weight/Unicode declarations with local asset URLs; Vite fingerprints and serves each WOFF2 separately.

Manrope: Copyright 2018 The Manrope Project Authors, SIL Open Font License 1.1; see `manrope-OFL.txt`.
IBM Plex Mono: Copyright © 2017 IBM Corp., Reserved Font Name “Plex”, SIL Open Font License 1.1; see `ibmplexmono-OFL.txt`.

Both full license notices are also emitted with static site documents. Fetching updates is a reviewed source change, never a build or test prerequisite.

License notices preserve every word with normalized LF line endings and trailing whitespace. The provenance manifest records both original upstream and distributed hashes.

# Changelog

## 1.0.0-rc.1 — 2026-10-12

Source checkpoint for the next website release. Committing this version does not deploy it.

- Dedicated Decoder workspace with map/results review, aircraft symbols, optional traffic tracks, map panning, held framing, selection and exports.
- Account-free station Search with local guides, favorites and deliberate application of public catalog references.
- Recoverable browser-storage recording library, explicit retention/deletion, quota information and navigation protection.
- File-backed replay up to 2 GiB, pause/resume and stopped range selection, with guarded and cancellable imports.
- Worker hashing, bounded packet-buffer reuse, deferred workspaces and progressive map detail, with build byte budgets.
- Accessible tuning controls, improved phone ordering, visible survey-save/recovery status and dated support evidence in Help.

Remaining acceptance includes current physical receiver/mode/browser coverage, audible output, longer loaded-host runs and large-file/storage limits. Browser storage can be evicted; interrupted captures recover committed samples only. Some constrained map actions exceed the 200 ms target. Generated tests do not establish RF reception or universal device support.

## Version policy

`package.json` is the application version; the lockfile must match it. About displays that version alongside the independent build identity. Release metadata records the version from the frozen source.

Use `MAJOR.MINOR.PATCH`: major for incompatible supported behavior or format changes, minor for compatible features, patch for compatible fixes. Before stable 1.0, use `1.0.0-rc.N` for successive candidates. Stable `1.0.0` requires an explicit release decision after reviewing the candidate's software checks and scoped independent acceptance. Experimental hardware/modes retain their labels.

Record each released version here. Release IDs, source hashes and deployment records continue to identify exact artifacts. Existing data, wire and export schema versions remain independently versioned. Released version numbers are immutable; changed releases receive a new version. An intentional rollback may reactivate a previously verified artifact.

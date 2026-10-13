# Optional compatibility collector

The existing Node/SQLite collector accepts diagnostic and legacy compatibility reports. Structured community reports use schemaVersion 2 on the same compatibility POST route. Help reads a separate public projection. Run with the project's pinned Node runtime and a persistent private SQLite database; no collector is required to use the receiver.

| Route | Behavior |
| --- | --- |
| POST `/api/v1/diagnostic-reports` | Existing private diagnostic intake |
| POST `/api/v1/compatibility-reports` | Existing v1 or structured v2 intake, 32 KiB limit |
| GET `/api/v1/compatibility-matrix?build=ID` | Public allowlisted evidence for a registered exact build; defaults to newest registered build |
| POST `/api/v1/compatibility-reports/withdraw` | Remove a report using its private `{reference, receipt}` |

Proxy these routes to the loopback collector, including the withdrawal subpath. Strip cookies, Authorization and forwarded client identity; disable access/body logging for report and withdrawal routes. Return `Cache-Control: no-store` for the projection and write acknowledgements. The browser omits credentials. Existing deployed proxy configuration must be updated separately from frontend/collector activation.

## Build registration and review

The collector discovers trusted metadata from `BROWSERSDR_REPORT_RELEASE_JSON` (default `/var/www/browsersdr.com/current/release.json`). Metadata accepts `{id, version, builtAt}` or the release builder's `{release, version, builtAt, ...}`. IDs are immutable: changing the version or timestamp of an existing ID is rejected. A client-supplied build ID is not attestation; registration limits the available claims. Unregistered and development reports are rejected.

To register a candidate or record engine evidence, supply a private metadata file and use the administration CLI against the same database:

```sh
BROWSERSDR_REPORT_DB=/private/reports.sqlite node deploy/report-service/report-admin.mjs community-build /private/build.json
BROWSERSDR_REPORT_DB=/private/reports.sqlite node deploy/report-service/report-admin.mjs community-list
BROWSERSDR_REPORT_DB=/private/reports.sqlite node deploy/report-service/report-admin.mjs show BC-REFERENCE
BROWSERSDR_REPORT_DB=/private/reports.sqlite node deploy/report-service/report-admin.mjs community-review BC-REFERENCE accepted
```

Use `accepted` only after checking test scope and independence. A random browser token deduplicates ordinary retries; it cannot prove physical independence. `excluded` removes that report's current votes from the public projection. `resolved` clears an earlier issue only for a corrected current positive; acceptance and issue resolution are separate operations. Record the reasoning/evidence in private operator records. Corrections reset review. Legacy v1 reports never contribute to community counts.

Optional trusted `engineChecks` entries contain `{feature, result: "passed"|"failed", checkedAt, evidence}`. Evidence URLs must be HTTPS on github.com or browsersdr.com. Record results only for the registered exact build and inspected check. Nothing is automatically marked passed from a registry entry or a local test run.

## Counts and retention

Two reviewed independent working reports meeting the selected duration confirm a compatible cell: smoke at least 5 minutes, sustained at least 30. Reception cells keep different builds, origins, rates, hardware variants, profiles, firmware, decoder protocols and test scopes separate. Browser/OS partitions access and common runtime checks; decoder reports retain platform provenance without duplicating the entire matrix. Display checks also distinguish the actual renderer. Runtime checks remain split by reported rates. A later positive does not erase an unresolved problem.

Private bodies/notes expire after 30 days. Normalized votes, revisions and withdrawal receipts expire after 90 days; expiry and withdrawal recompute live counts. Build metadata remains, and expired cells become untested. There is no permanent positive archive in this pilot. Public output omits tokens, report IDs/references/receipts, notes, frequencies, location, device serials, filenames and signal payloads. It includes coarse platform and tested setup/duration evidence.

Keep the downloaded withdrawal receipt private. Help can load it locally after a reload; loading does not transmit it until the user presses Withdraw. A correction uses a new report ID and the same build-scoped participation token, replacing the participant's current verdict for that cell. Withdrawing a superseded report does not remove its newer correction or resurrect an older vote.

## Verification

`npm run test:report-service` exercises the real isolated HTTP/SQLite collector. `e2e/community-reports.e2e.ts` uses a test-only route adapter to that collector, never production. Set `VITE_BUILD_ID` and `VITE_BUILD_TIMESTAMP` to an exact registered test build to exercise submission; an ordinary unstamped development build exercises download-only reporting. Generated reports establish reporting mechanics, not RF reception, audible output or physical compatibility.

## Unified reporting UI

The ? menu separates Compatibility & tests (matrices and the only report action) from Help & setup (passive setup/FAQ guidance). Legacy v1 intake remains compatible with older clients; the current app uses the structured v2 form. Optional `receiverDetails` carries bounded gain/bandwidth/squelch/power/API/session state, and optional `browserCapabilities` carries capability booleans. Both are private, expire with the report body and are excluded from vote storage/public projection. Exact frequency and locale are not collected. Tuning is individually reportable.

New RTL-SDR reports use the existing generic `rtl-unknown` ID labelled RTL-SDR. The collector accepts historical model IDs and normalizes new intake to that family before deduplication. Historical ledger cells remain readable and share one displayed row; different retained setup keys do not automatically combine into confirmation. No existing ledger is rewritten.

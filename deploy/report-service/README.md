# Optional compatibility collector

The existing Node/SQLite collector accepts diagnostic and legacy compatibility reports. Structured community reports use schemaVersion 2 on the same compatibility POST route. Help reads a separate public projection. Run with the project's pinned Node runtime and a persistent private SQLite database; no collector is required to use the receiver.

| Route | Behavior |
| --- | --- |
| POST `/api/v1/diagnostic-reports` | Existing private diagnostic intake |
| POST `/api/v1/compatibility-reports` | Existing v1 or structured v2 intake, 32 KiB limit |
| GET `/api/v1/compatibility-matrix?build=ID` | Public schemaVersion 2 projection with separate fresh and explicitly carried evidence; defaults to newest registered build |
| POST `/api/v1/compatibility-reports/withdraw` | Remove a report using its private `{reference, receipt}` |

Proxy these routes to the loopback collector, including the withdrawal subpath. Strip cookies, Authorization and forwarded client identity; disable access/body logging for report and withdrawal routes. Return `Cache-Control: no-store` for the projection and write acknowledgements. The browser omits credentials. Existing deployed proxy configuration must be updated separately from frontend/collector activation.

## Build registration and review

The collector discovers trusted metadata from `BROWSERSDR_REPORT_RELEASE_JSON` (default `/var/www/browsersdr.com/current/release.json`). Metadata accepts `{id, version, builtAt}` or the release builder's `{release, version, builtAt, ...}`. IDs are immutable: changing the version or timestamp of an existing ID is rejected. A client-supplied build ID is not attestation; registration limits the available claims. Unregistered and development reports are rejected.

To register a candidate or record engine evidence, supply a private metadata file and use the administration CLI against the same database:

```sh
BROWSERSDR_REPORT_DB=/private/reports.sqlite node deploy/report-service/report-admin.mjs community-build /private/build.json
BROWSERSDR_REPORT_DB=/private/reports.sqlite node deploy/report-service/report-admin.mjs community-list
BROWSERSDR_REPORT_DB=/private/reports.sqlite node deploy/report-service/report-admin.mjs show BC-REFERENCE
BROWSERSDR_REPORT_DB=/private/reports.sqlite node deploy/report-service/report-admin.mjs community-review BC-REFERENCE excluded
```

Reports contribute automatically; there is no maintainer approval step. A random browser token deduplicates ordinary retries; it cannot prove physical independence. Investigate suspected misuse using `community-list` and `show`, then use `excluded` to remove that report's current votes from the public projection. The legacy `accepted` command can restore an excluded report; it is not required for ordinary contributions. `resolved` clears an earlier issue only for a corrected current positive. Record moderation reasoning/evidence in private operator records. Corrections replace current votes and preserve unresolved issues. Legacy v1 reports never contribute to community counts.

Optional trusted `engineChecks` entries contain `{feature, result: "passed"|"failed", checkedAt, evidence}`. Evidence URLs must be HTTPS on github.com or browsersdr.com. Record results only for the registered exact build and inspected check. Nothing is automatically marked passed from a registry entry or a local test run.

## Carrying unchanged feature evidence between releases

Reports remain attached to their exact tested build. The collector can display those original votes on a later release through an explicitly registered feature equivalence. It never copies votes, changes their dates or renews their 90-day lifetime. Fresh and carried progress stay separate: one fresh positive plus one carried positive cannot confirm a cell. Two qualifying positives on the original build can appear as **Confirmed · carried**, with that build, original observation dates/expiry and the target integration-check reference in details. Relevant issues from either build override confirmation. Withdrawal, exclusion, corrections, issue resolution and expiry on the source immediately affect carried results on the next matrix read.

Carry-forward is trusted operator metadata, not a client report field or public HTTP write. Register immutable `evidenceFingerprints` on both builds, keyed by feature IDs from the report catalog. These are SHA-256 hashes of the reviewed feature dependency inputs. A fingerprint may be added to an existing build identity after inspecting its exact frozen source; an existing feature fingerprint cannot be changed. Do not fabricate a matching value because a change is described as cosmetic.

The helper generates fingerprints and per-file hashes from a reviewed manifest:

```json
{
  "schemaVersion": 1,
  "features": {
    "rds": { "buildContext": { "flags": {}, "toolchain": "record exact compiler/runtime and external artifact identities" } },
    "display": { "buildContext": { "flags": {}, "toolchain": "record exact compiler/runtime and external artifact identities" } }
  }
}
```

```sh
node scripts/community-evidence-fingerprint.mjs /private/frozen-source /private/reviewed-dependencies.json /private/fingerprint-evidence.json
```

Output must be outside the frozen source and must not already exist. The conservative default includes runtime source under `src/`, `wasm/` and `third_party/`, including integration/UI code and compiled WASM, plus package/lock data, pinned Node, Vite/TypeScript configuration, HTML and native build scripts. Tests/test fixtures and build cache directories are omitted. CSS and `src/assets/` are omitted for features other than display; their runtime impact still requires a target integration smoke check. Application version fields alone do not change the fingerprint; dependency, compiler/configuration, input-file additions and applicable runtime changes do. Record applicable build flags and external/toolchain artifacts in `buildContext`; the helper does not infer them from environment variables. Dependency coverage must be reviewed, including any runtime inputs outside the default roots.

An optional feature `exclude` array contains reviewed exact paths or directory prefixes under the three runtime roots. Exclusions must match existing dependency paths, are themselves hashed into the fingerprint, and must be identical for both builds. Use them only after proving a path cannot affect that feature. Unknown/shared scheduling, lifecycle, sample handling or worker dependencies stay included. Display changes may therefore require a fresh display check even if reception evidence can carry. A mismatch or missing fingerprint means no carry. Hash equality detects unchanged reviewed inputs; it does not prove integrated runtime behavior.

Merge only the helper's `evidenceFingerprints` object into each build's private registration file and retain its dependency evidence with the release records. Then run a current target integration check for the intended feature/setup coverage, inspect intervening releases and unresolved issues, and register one source build per target feature:

```json
{
  "sourceBuildId": "ORIGINAL_BUILD_ID",
  "targetBuildId": "NEW_BUILD_ID",
  "feature": "rds",
  "fingerprint": "REPLACE_WITH_THE_MATCHING_64_CHARACTER_SHA256",
  "checkedAt": "REPLACE_WITH_ACTUAL_TARGET_CHECK_TIME",
  "evidence": "https://github.com/OWNER/REPOSITORY/actions/runs/ACTUAL_CHECK"
}
```

```sh
BROWSERSDR_REPORT_DB=/private/reports.sqlite node deploy/report-service/report-admin.mjs community-build /private/original-build.json
BROWSERSDR_REPORT_DB=/private/reports.sqlite node deploy/report-service/report-admin.mjs community-build /private/target-build.json
BROWSERSDR_REPORT_DB=/private/reports.sqlite node deploy/report-service/report-admin.mjs community-equivalence /private/equivalence.json
BROWSERSDR_REPORT_DB=/private/reports.sqlite node deploy/report-service/report-admin.mjs community-revoke-equivalence NEW_BUILD_ID rds
```

Both builds must already be registered with the same feature fingerprint, the source timestamp must precede the target, and the integration check must fall between target build time and now. Evidence URLs use the same HTTPS github.com/browsersdr.com allowlist as engine checks. The equivalence covers the feature's existing setup scopes; it cannot merge rates, variants, firmware, origins, protocols, platforms or renderers. If unchanged inputs cannot be established for the whole feature coverage, do not register it. Record the scope review and reasoning in private operator evidence. One immutable source/check record is allowed per target feature; revoke it if its dependency or integration assumptions are disproved. The identical record can be explicitly re-enabled. Different source choices require a new target build. The low-level collector does not select sources itself. The approved [release integration](#automatic-release-integration) selects one eligible original automatically; there is no transitive inheritance or stacking of builds, and reverted code cannot revive a revoked link.

Exact-build `engineChecks` remain fresh reference results. Eligible source engine checks appear only in `carriedEngineChecks`, preserving their original build, result/date/link and the separate equivalence reference; a carried pass is never a new exact-build pass. All existing release/CI and physical acceptance gates remain in force.

The projection now uses schemaVersion 2 so older clients cannot misrepresent inherited confirmation as fresh votes; they report an unavailable matrix until refreshed. The updated client still accepts ordinary schemaVersion 1 projections without carried fields. Ship frontend and collector together. SQLite initialization adds only `community_fingerprints` and `community_equivalences`; existing report/vote/receipt records are not rewritten. No production equivalence is registered by installing the software alone.

## Counts and retention

Working reports meeting the selected duration count immediately: smoke at least 5 minutes, sustained at least 30. Two distinct participation tokens confirm a compatible cell; this is community-reported confirmation, not verified device independence. Reception cells keep different builds, origins, rates, hardware variants, profiles, firmware, decoder protocols and test scopes separate. Browser/OS partitions access and common runtime checks; decoder reports retain platform provenance without duplicating the entire matrix. Display checks also distinguish the actual renderer. Runtime checks remain split by reported rates. A later positive does not erase an unresolved problem.

Existing pending and previously accepted votes follow the same duration rules without resubmission or a database migration. Excluded votes remain excluded. The existing public `review` field is retained as legacy metadata for wire compatibility, has no effect on eligibility and is not shown by the current UI. New frontend and collector changes must ship together; older frontends still display the old review wording.

Private bodies/notes expire after 30 days. Normalized votes, revisions and withdrawal receipts expire after 90 days; expiry and withdrawal recompute live counts. Build metadata remains, and expired cells become untested. There is no permanent positive archive in this pilot. Public output omits tokens, report IDs/references/receipts, notes, frequencies, location, device serials, filenames and signal payloads. It includes coarse platform and tested setup/duration evidence.

Keep the downloaded withdrawal receipt private. Help can load it locally after a reload; loading does not transmit it until the user presses Withdraw. A correction uses a new report ID and the same build-scoped participation token, replacing the participant's current verdict for that cell. Withdrawing a superseded report does not remove its newer correction or resurrect an older vote.

## Verification

`npm run test:report-service` exercises the real isolated HTTP/SQLite collector. `e2e/community-reports.e2e.ts` uses a test-only route adapter to that collector, never production. Set `VITE_BUILD_ID` and `VITE_BUILD_TIMESTAMP` to an exact registered test build to exercise submission; an ordinary unstamped development build exercises download-only reporting. Generated reports establish reporting mechanics, not RF reception, audible output or physical compatibility.

## Unified reporting UI

The ? menu separates Compatibility & tests (matrices and the only report action) from Help & setup (passive setup/FAQ guidance). Legacy v1 intake remains compatible with older clients; the current app uses the structured v2 form. Optional `receiverDetails` carries bounded gain/bandwidth/squelch/power/API/session state, and optional `browserCapabilities` carries capability booleans. Both are private, expire with the report body and are excluded from vote storage/public projection. Exact frequency and locale are not collected. Tuning is individually reportable.

New RTL-SDR reports use the existing generic `rtl-unknown` ID labelled RTL-SDR. The collector accepts historical model IDs and normalizes new intake to that family before deduplication. Historical ledger cells remain readable and share one displayed row; different retained setup keys do not automatically combine into confirmation. No existing ledger is rewritten.

## Automatic release integration

The canonical release builder runs `scripts/check-community-release.mjs SITE FROZEN_SOURCE` after the stamped build. It computes fingerprints using `community-evidence-policy.json`, runs the complete Chromium integration suite against that exact payload (one worker, no retries), and writes `communityCarryCheck` plus fingerprints into release metadata. The public `community-evidence/BUILD_ID.json` records actual source hashes, normalized dependency hashes, policy and check results. Additional Vite flags are hashed; identity stamps are excluded. A failed or incomplete check stops packaging.

Activation invokes `community-release.mjs RELEASE_JSON` against the private collector database. In one transaction it registers immutable fingerprints and chooses a matching original build with unexpired, non-excluded votes, preferring the greatest number of compatible setups and then the newest original. It never adds participation counts across builds or uses another build's inherited projection as a source. Before creating a link, unresolved issues on another original with matching or unknown feature inputs require review (`review-required-issues`); greater positive setup coverage cannot hide them. Known changed inputs, excluded/expired votes and explicitly resolved issues do not block selection. Existing links remain fixed and revoked links stay revoked. Every checked feature receives an explicit registration or no-match decision in the release history. Activation then verifies the live projection against that receipt; failure triggers the existing code rollback. Prior public audit URLs are retained alongside old assets.

For an authorized historical bootstrap, pass a JSON array of independently audited original build metadata as a second argument:

```sh
BROWSERSDR_REPORT_DB=/private/reports.sqlite node deploy/report-service/community-release.mjs /private/checked-target.json /private/audited-originals.json
node deploy/report-service/community-release.mjs --verify /private/checked-target.json /private/receipt.json 'https://browsersdr.com/api/v1/compatibility-matrix?build=TARGET_ID'
```

The policy defaults to complete runtime/build inputs for every feature. The reviewed `access` scope excludes decoding, audio, recording and passive presentation, retaining connection/controller/backends, native drivers and explicitly included UI resource/source entry points. Optional exclusions may name independent modules absent from an older frozen source. Required `include` paths override excluded directories. Unknown files outside the declared exclusions still change the fingerprint.

`reviewedVariants` is an explicit, exact-byte audit of non-feature changes within a shared file. Each rule records original anchor SHA-256, allowed complete-file hashes and reasoning. Only listed hashes normalize to that stable anchor; a new unreviewed edit remains different. Raw hashes are always retained in `sourceDependencies`. Adding a reviewed equivalent variant does not rewrite an existing immutable fingerprint; a change to feature behavior requires a different fingerprint, never another equivalent variant. Changes to connection logic, shared ownership or native requests cannot be classified as cosmetic. The initial access review covers 1.4.0 to 1.7.x: unchanged connection behavior, with new optional decoder metadata and receiving-only branches. Other changed processing/display/decoder paths remain fresh until independently qualified.

Automated software checks validate target integration; they do not produce a hardware report, prove RF reception or renew original dates/expiry. The release's existing quality and physical acceptance requirements remain independent. Use the current canonical builder/activation inputs for new releases; retained older activation scripts are rollback records, not substitutes for the current release integration.

# Exact-source CI promotion

This optional path replaces a repeated **main browser matrix** with complete,
verified original ordinary-source coverage plus independent fresh stability cases.
Fresh main quality/build, complete stamped release qualification, all cold risks,
actual packaged API/TURN cases and every deployment/live/preservation obligation
remain separate. Original tests, fixtures, deadlines and assertions are unchanged.

Ordinary CI runs the complete matrix by default. No repository variable is set by
this code. A reviewable pilot can be dispatched on a published candidate branch:

```sh
gh workflow run ci.yml --ref CANDIDATE_BRANCH \
  -f qualification_id=FRESH_UUID -f promotion_run_id=COMPLETE_ORDINARY_PUSH_RUN_ID
```

The display title is `CI promotion UUID`, distinct from full dedicated browser
qualification. A pilot cannot replace a main gate: its final proof explicitly
sets `canReplaceMainBrowserGate:false`. A later reviewed adoption may enable the
repository variable `BSD_MAIN_PROMOTION_ENABLED=true`; only pushes to main then
look for eligible original source evidence. Other events retain full CI. If no
eligible source exists, main runs the complete matrix. Invalid requested evidence,
context changes or damaged artifacts fail closed; a full dispatch with no source
ID remains available. Never silently retry failed tests or weaken deadlines.

An eligible source is a completed, successful first-attempt **ordinary branch push**
in this repository, at the exact same commit and CI workflow identity, less than
24 hours old. Fork/PR, stamped/dedicated, recursive promotion, failed/incomplete,
rerun or main evidence is rejected. Six original jobs/artifacts, four distinct
hosted runner IDs, authoritative archive sizes/SHA256, safe extraction, complete
two-target shard union, native merged report, approved skips and zero retries
are checked. Clean source, Node/platform/architecture, lockfile/workflow,
Playwright/build tools, build flags, exact immutable production bytes and hosted
runner image must match the fresh quality build. Custom fixture contexts require
fresh qualification. Raw archives are retained during verification; downloaded
code/configuration is never executed.

`browser-promotion-policy.json` maps known startup, high-rate, lifecycle, EOF,
geometry and offline-update failures to existing tests. Every named case must
exist exactly once per target in the full source proof and fresh discovery. Four
new runner instances execute these cases with one browser worker and zero retries;
none may skip. Fresh and inherited inventories remain visibly distinct. The final
coverage job rechecks authoritative source metadata/attempt/artifact identity and
rejects reused runner instances or missing/altered stability evidence.

`promotion-summary.json` states inherited full coverage, original skips, fresh
stability coverage, both sets of runners and the source/run/artifact identity.
Its `independentFullMainExecution:false` must never be relabelled as a new full
main run. Existing full-only release operators deliberately reject this partial
native report until they explicitly support this evidence policy.

For independent review, use a fresh clean checkout of the exact commit, locked
dependencies/Node and a read-only Actions token. Set `GITHUB_REPOSITORY`,
`GITHUB_SHA` and `GITHUB_RUN_ATTEMPT=1`, then run:

```sh
node scripts/browser-promotion.mjs audit PROMOTION_RUN_ID PRIVATE_NEW_OUTPUT
```

The audit downloads and SHA-verifies every current **and original** archive,
reconstructs full source and fresh stability proof, verifies both native reports,
and compares its result with the published promotion proof. It writes only local
evidence and immutable build output; it does not push, register reports or deploy.

import { useCallback, useEffect, useRef, useState } from "react";
import {
  COMMUNITY_FEATURES,
  COMMUNITY_GROUPS,
  COMMUNITY_HARDWARE,
  COMMUNITY_REPORT_HARDWARE,
  communityHardwareRowId,
  type CommunityFeatureId,
  type CommunityHardwareId,
} from "../diagnostics/communityCatalog";
import {
  COMMUNITY_BUILD,
  readCommunityMatrix,
} from "../diagnostics/communityReports";
import type {
  CommunityCell,
  CommunityMatrix,
} from "../diagnostics/communityTypes";
import type { CompatibilityReportContext } from "../diagnostics/compatibilityTypes";
import { CommunityTestReport } from "./CommunityTestReport";
import { CommunityHardwareIcon } from "./CommunityHardwareIcon";
import "./CommunityCompatibility.css";

type View = "modes" | "platform" | "engine";
const DEFAULT_ROWS = new Set([
  "rtl-unknown",
  "hackrf-pro",
  "bladerf-xa4",
  "bladerf-xa5",
  "bladerf-xa9",
  "usrp-b205mini-i",
]);
const viewNames = {
  modes: "Reception & decoders",
  platform: "Platform compatibility",
  engine: "Engine checks",
};

export function communityCellSummary(cells: CommunityCell[]): {
  status: string;
  count: string;
  label: string;
} {
  if (!cells.length)
    return { status: "untested", count: "0/2", label: "Untested" };
  if (cells.some((c) => c.problems > 0))
    return {
      status: "issue",
      count: `${cells.reduce((n, c) => n + c.problems, 0)} issue(s)`,
      label: "Issue reported",
    };
  if (cells.length > 1)
    return {
      status: cells.some((c) => c.status === "confirmed")
        ? "confirmed"
        : "working",
      count: `${cells.length} setups`,
      label: cells.some((c) => c.status === "confirmed")
        ? "Some confirmed"
        : "Setup reports",
    };
  const cell = cells[0]!;
  return {
    status: cell.status,
    count:
      cell.eligibleWorking >= 2
        ? "2/2+"
        : `${Math.min(1, cell.eligibleWorking)}/2`,
    label:
      cell.status === "confirmed"
        ? "Confirmed"
        : cell.working
          ? cell.eligibleWorking
            ? "Reported working"
            : "Longer test needed"
          : "Untested",
  };
}

export function CommunityCompatibility({
  context,
  renderer,
  blockedReason,
}: {
  context: CompatibilityReportContext;
  renderer?: "webgpu" | "canvas2d";
  blockedReason?: string;
}) {
  const [matrix, setMatrix] = useState<CommunityMatrix>();
  const [buildId, setBuildId] = useState<string>();
  const [view, setView] = useState<View>("modes");
  const [group, setGroup] = useState<string>("data");
  const [selection, setSelection] = useState<{
    title: string;
    keys: string[];
  }>();
  const [platformPage, setPlatformPage] = useState(0);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const generation = useRef(0);
  const pending = useRef<AbortController | undefined>(undefined);
  const load = useCallback(async () => {
    if (document.hidden) return;
    pending.current?.abort();
    const aborter = new AbortController();
    pending.current = aborter;
    const token = ++generation.current;
    try {
      const next = await readCommunityMatrix(buildId, aborter.signal);
      if (token !== generation.current || aborter.signal.aborted) return;
      setMatrix(next);
      setError("");
    } catch (reason) {
      if (token === generation.current && !aborter.signal.aborted)
        setError(
          reason instanceof Error ? reason.message : "Reports are unavailable.",
        );
    } finally {
      if (token === generation.current) setLoading(false);
    }
  }, [buildId]);
  useEffect(() => {
    void load();
    const timer = setInterval(() => {
      if (!document.hidden) void load();
    }, 60_000);
    const visible = () => {
      if (!document.hidden) void load();
      else pending.current?.abort();
    };
    document.addEventListener("visibilitychange", visible);
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", visible);
      pending.current?.abort();
    };
  }, [load]);
  const currentId = buildId ?? matrix?.buildId;
  const sameBuild = matrix?.buildId === (currentId ?? null);
  const cells = sameBuild ? (matrix?.cells ?? []) : [];
  const builds = matrix?.builds ?? [];
  const features = COMMUNITY_FEATURES.filter((f) => f.group === group);
  const hardware = COMMUNITY_REPORT_HARDWARE.filter(
    (h) =>
      DEFAULT_ROWS.has(h.id) ||
      cells.some((c) => communityHardwareRowId(c.hardwareId) === h.id),
  );
  const allPlatforms = [
    ...new Set(cells.flatMap((c) => (c.platform ? [c.platform] : []))),
  ].sort();
  const effectivePlatformPage = Math.min(
    platformPage,
    Math.max(0, Math.ceil(allPlatforms.length / 4) - 1),
  );
  const platforms = allPlatforms.slice(
    effectivePlatformPage * 4,
    effectivePlatformPage * 4 + 4,
  );
  const selected =
    selection?.keys.flatMap((key) => cells.find((c) => c.key === key) ?? []) ??
    [];
  const choose = (title: string, cases: CommunityCell[]) =>
    setSelection({ title, keys: cases.map((c) => c.key) });
  const matching = (
    feature: CommunityFeatureId,
    hardwareId?: CommunityHardwareId,
    platform?: string,
  ) =>
    cells.filter(
      (c) =>
        c.feature === feature &&
        (!hardwareId || communityHardwareRowId(c.hardwareId) === hardwareId) &&
        (platform === undefined || c.platform === platform),
    );
  const cell = (title: string, cases: CommunityCell[], key: string) => {
    const summary =
      !matrix || !sameBuild || !matrix.buildId
        ? {
            status: "untested",
            count: "—",
            label: error
              ? "Unavailable"
              : loading
                ? "Loading"
                : "No registered build",
          }
        : communityCellSummary(cases);
    return (
      <td key={key}>
        <button
          type="button"
          className={`secondary community-cell is-${summary.status}`}
          aria-label={`${title}: ${summary.label}`}
          onClick={() => choose(title, cases)}
        >
          <span>{summary.count}</span>
          <small>{summary.label}</small>
        </button>
      </td>
    );
  };
  const platformTable = (runtime: boolean) => (
    <div className="community-table-wrap">
      <table>
        <caption>{runtime ? "Common runtime" : "Hardware access"}</caption>
        <thead>
          <tr>
            <th scope="col">
              {runtime ? "Platform function" : "USB receiver"}
            </th>
            {platforms.map((p) => (
              <th key={p} scope="col">
                {p}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {runtime
            ? COMMUNITY_FEATURES.filter((f) => f.group === "runtime").map(
                (f) => (
                  <tr key={f.id}>
                    <th scope="row">{f.label}</th>
                    {platforms.map((p) =>
                      cell(
                        `${f.label} · ${p}`,
                        matching(f.id, undefined, p),
                        p,
                      ),
                    )}
                  </tr>
                ),
              )
            : hardware
                .filter((h) => !["replay", "synthetic"].includes(h.source))
                .map((h) => (
                  <tr key={h.id}>
                    <th scope="row">
                      <span className="community-hardware-name">
                        {h.label}
                        <CommunityHardwareIcon source={h.source} />
                      </span>
                    </th>
                    {platforms.map((p) =>
                      cell(`${h.label} · ${p}`, matching("access", h.id, p), p),
                    )}
                  </tr>
                ))}
        </tbody>
      </table>
    </div>
  );
  return (
    <section
      className="help-panel community-compatibility"
      aria-labelledby="community-title"
    >
      <div className="community-toolbar">
        <div className="community-toolbar-title">
          <h2 id="community-title">Community tests</h2>
          <span>What works on your receiver?</span>
        </div>
        <CommunityTestReport
          context={context}
          renderer={renderer}
          blockedReason={blockedReason}
          onSent={() => void load()}
        />
      </div>
      <div className="community-control-row">
        <span className="community-control-label">Version</span>
        <div
          className="community-versions"
          role="tablist"
          aria-label="Community software version"
          onKeyDown={(event) => {
            if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key))
              return;
            const tabs = Array.from(
              event.currentTarget.querySelectorAll<HTMLButtonElement>(
                '[role="tab"]',
              ),
            );
            const index = tabs.findIndex(
              (tab) => tab === document.activeElement,
            );
            if (index < 0) return;
            event.preventDefault();
            const next =
              event.key === "Home"
                ? 0
                : event.key === "End"
                  ? tabs.length - 1
                  : (index +
                      (event.key === "ArrowRight" ? 1 : -1) +
                      tabs.length) %
                    tabs.length;
            tabs[next]?.focus();
            tabs[next]?.click();
          }}
        >
          {builds.map((build, i) => (
            <button
              key={build.id}
              className="secondary"
              type="button"
              role="tab"
              id={`community-version-${i}`}
              aria-controls="community-evidence-panel"
              aria-selected={currentId === build.id}
              tabIndex={currentId === build.id ? 0 : -1}
              onClick={() => {
                setBuildId(build.id);
                setSelection(undefined);
                setLoading(true);
              }}
            >
              {build.version}
              <small>
                {new Date(build.builtAt).toLocaleDateString()} ·{" "}
                {build.id.slice(-8)} ·{" "}
                {build.id === COMMUNITY_BUILD.id
                  ? "This build"
                  : "Recorded build"}
              </small>
            </button>
          ))}
        </div>
      </div>
      {loading && <p role="status">Loading community reports…</p>}
      {error && (
        <p role="status" className="community-error">
          {error}{" "}
          {matrix && "Previously loaded evidence is shown; it may be stale."}{" "}
          <button
            type="button"
            className="secondary"
            onClick={() => void load()}
          >
            Retry community reports
          </button>
        </p>
      )}
      {!loading && !error && !builds.length && (
        <p>
          No registered release builds yet. Community confirmation starts with
          reports from an exact registered build.
        </p>
      )}
      <div
        id="community-evidence-panel"
        role="tabpanel"
        aria-labelledby={
          builds.length
            ? `community-version-${Math.max(
                0,
                builds.findIndex((b) => b.id === currentId),
              )}`
            : "community-title"
        }
      >
        <div className="community-control-row">
          <span className="community-control-label">View</span>
          <div className="community-views" aria-label="Community evidence view">
            {(Object.keys(viewNames) as View[]).map((v) => (
              <button
                type="button"
                key={v}
                className="secondary"
                aria-pressed={view === v}
                onClick={() => {
                  setView(v);
                  setSelection(undefined);
                }}
              >
                {viewNames[v]}
              </button>
            ))}
          </div>
        </div>
        {view === "modes" && (
          <>
            <div className="community-control-row">
              <span className="community-control-label">Category</span>
              <div
                className="community-groups"
                aria-label="Community decoder category"
              >
                {COMMUNITY_GROUPS.map((g) => (
                  <button
                    type="button"
                    key={g.id}
                    className="secondary"
                    aria-pressed={group === g.id}
                    onClick={() => {
                      setGroup(g.id);
                      setSelection(undefined);
                    }}
                  >
                    {g.label}
                  </button>
                ))}
              </div>
            </div>
            <p className="community-context">
              Confirmation applies to reported setups. Browser and OS details
              are listed with each report.
            </p>
            <div className="community-table-wrap">
              <table aria-label="Community hardware and decoder matrix">
                <thead>
                  <tr>
                    <th scope="col">Hardware</th>
                    {features.map((f) => (
                      <th key={f.id} scope="col">
                        {f.label}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {hardware.map((h) => (
                    <tr key={h.id}>
                      <th scope="row">
                        <span className="community-hardware-name">
                          {h.label}
                          <CommunityHardwareIcon source={h.source} />
                        </span>
                        {["replay", "synthetic"].includes(h.source) && (
                          <small>
                            {h.source === "replay"
                              ? "Recorded I/Q"
                              : h.source === "synthetic"
                                ? "Generated samples"
                                : "Live RF reports"}
                          </small>
                        )}
                      </th>
                      {features.map((f) =>
                        cell(
                          `${h.label} · ${f.label}`,
                          matching(f.id, h.id).filter(
                            (c) => c.platform === null,
                          ),
                          f.id,
                        ),
                      )}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
        {view === "platform" && (
          <>
            <p>
              Hardware access and common runtime checks are tested separately
              from individual decoders.
            </p>
            {platforms.length ? (
              <>
                {allPlatforms.length > 4 && (
                  <div className="community-actions">
                    <button
                      type="button"
                      disabled={effectivePlatformPage === 0}
                      onClick={() => setPlatformPage(effectivePlatformPage - 1)}
                    >
                      Previous platforms
                    </button>
                    <span>
                      Platforms {effectivePlatformPage * 4 + 1}–
                      {Math.min(
                        allPlatforms.length,
                        effectivePlatformPage * 4 + 4,
                      )}{" "}
                      of {allPlatforms.length}
                    </span>
                    <button
                      type="button"
                      disabled={
                        (effectivePlatformPage + 1) * 4 >= allPlatforms.length
                      }
                      onClick={() => setPlatformPage(effectivePlatformPage + 1)}
                    >
                      Next platforms
                    </button>
                  </div>
                )}
                {platformTable(false)}
                {platformTable(true)}
              </>
            ) : (
              <p>
                No platform observations for this build yet. Browser
                capabilities alone do not establish a passing test.
              </p>
            )}
          </>
        )}
        {view === "engine" && (
          <>
            <p>
              Maintainer-recorded reference checks for this exact build. These
              are separate from community votes and physical reception.
            </p>
            <div className="community-table-wrap">
              <table aria-label="Exact-build engine checks">
                <thead>
                  <tr>
                    <th>Decoder / mode</th>
                    <th>Outcome</th>
                    <th>Evidence</th>
                  </tr>
                </thead>
                <tbody>
                  {COMMUNITY_FEATURES.filter((f) => f.mode).map((f) => {
                    const check = sameBuild
                      ? matrix?.engineChecks.find((c) => c.feature === f.id)
                      : undefined;
                    return (
                      <tr key={f.id}>
                        <th scope="row">{f.label}</th>
                        <td>
                          {check
                            ? check.result === "passed"
                              ? "Passed"
                              : "Failed"
                            : "Not recorded"}
                        </td>
                        <td>
                          {check ? (
                            <a
                              href={check.evidence}
                              target="_blank"
                              rel="noreferrer"
                            >
                              {new Date(check.checkedAt).toLocaleDateString()} ·
                              reference check
                            </a>
                          ) : (
                            "—"
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </>
        )}
        {view !== "engine" && (
          <p className="community-legend">
            Untested 0/2 · Reported working 1/2 · Confirmed 2/2+ · Issues remain
            visible. Reports meeting the test duration count immediately.
            Confirmation needs two participants; counts never combine different
            rates or test scopes.
          </p>
        )}
        {selection && (
          <section
            className="community-details"
            aria-label="Selected community test details"
          >
            <h3>{selection.title}</h3>
            {selected.length ? (
              selected.map((c) => (
                <div className="community-case" key={c.key}>
                  <h4>
                    {(c.setup.rateHz / 1e6).toLocaleString()} MS/s ·{" "}
                    {c.testScope} · {c.setup.origin}
                  </h4>
                  <p>
                    {c.setup.protocolProfile ?? "Protocol profile unknown"} ·
                    Firmware {c.setup.firmwareVersion ?? "unknown"} · Reported
                    native rate{" "}
                    {c.setup.nativeRateHz?.toLocaleString() ?? "unknown"}{" "}
                    samples/s
                  </p>
                  <p>
                    {c.working} positive report(s), {c.eligibleWorking}{" "}
                    qualifying positives, {c.problems} issue report(s).{" "}
                    {c.status === "confirmed"
                      ? "Community confirmed on reported setups."
                      : c.status === "issue"
                        ? "Unresolved issues remain visible."
                        : c.eligibleWorking
                          ? "Another participant’s qualifying report is needed."
                          : "Positive reports need a longer test to count toward confirmation."}
                  </p>
                  <ul>
                    {c.reports.map((r, i) => (
                      <li key={`${r.receivedAt}-${i}`}>
                        {r.environment.browser} ·{" "}
                        {r.environment.operatingSystem} · {r.durationMinutes}{" "}
                        minutes · {r.result.replaceAll("-", " ")}
                        {r.environment.renderer !== "unknown" &&
                          ` · ${r.environment.renderer}`}{" "}
                        ·{" "}
                        {
                          COMMUNITY_HARDWARE.find(
                            (h) => h.id === r.setup.hardwareId,
                          )?.label
                        }{" "}
                        · {(r.setup.rateHz / 1e6).toLocaleString()} MS/s ·{" "}
                        {new Date(r.receivedAt).toLocaleDateString()}
                      </li>
                    ))}
                  </ul>
                </div>
              ))
            ) : (
              <p>
                No report for this cell, or its evidence has changed. No
                compatibility pass is implied.
              </p>
            )}
            <button
              type="button"
              className="secondary"
              onClick={() => setSelection(undefined)}
            >
              Close test details
            </button>
          </section>
        )}
      </div>
      {matrix && (
        <small>
          Last refreshed {new Date(matrix.generatedAt).toLocaleString()} ·
          active view refreshes every minute · build{" "}
          {matrix.buildId ?? "not registered"}
        </small>
      )}
    </section>
  );
}

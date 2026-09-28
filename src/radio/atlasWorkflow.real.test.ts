import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import fixture from "../../docs/implementation/atlas-integration/fixtures/browsersdr-cu8-v1.json";
import { AtlasClient } from "./atlasClient";
import { AtlasTransferController } from "./atlasTransfer";
import type { PreparedRecordingExport } from "./recordingExportFormat";

const baseUrl = process.env.SIGNAL_ATLAS_BSD03_BASE_URL;
const operatorToken = process.env.SIGNAL_ATLAS_BSD03_OPERATOR_TOKEN;
const configured = Boolean(baseUrl && operatorToken);

function prepared(
  metadataValue: unknown = fixture.metadata,
  suffix = "contiguous",
): PreparedRecordingExport {
  const data = Uint8Array.from(Buffer.from(fixture.data_base64, "base64"));
  return {
    format: "sigmf",
    basename: `${fixture.basename}-${suffix}`,
    sampleCount: data.byteLength / 2,
    files: [
      {
        name: `${fixture.basename}-${suffix}.sigmf-data`,
        contents: data,
        type: "application/octet-stream",
      },
      {
        name: `${fixture.basename}-${suffix}.sigmf-meta`,
        contents: `${JSON.stringify(metadataValue, null, 2)}\n`,
        type: "application/json",
      },
    ],
  };
}

describe.skipIf(!configured)("configured real BSD-03 SigIntAtlas workflow", () => {
  it("retries, saves exact originals, schedules a pinned run, reopens, and archives a gap without analysis", async () => {
    const origin = new URL(baseUrl!).origin;
    const cookies = new Map<string, string>();
    let injectedLoss = false;
    let analysisCreates = 0;
    const browserFetch: typeof fetch = async (input, init = {}) => {
      const url = new URL(String(input), origin);
      if (
        !injectedLoss &&
        /\/uploads\/[^/]+\/parts\/\d+$/.test(url.pathname)
      ) {
        injectedLoss = true;
        throw new TypeError("BSD-03 injected pre-request network loss");
      }
      if (
        init.method === "POST" &&
        /\/recordings\/[^/]+\/analysis-runs$/.test(url.pathname)
      )
        analysisCreates += 1;
      const headers = new Headers(init.headers);
      headers.set("Origin", origin);
      if (cookies.size)
        headers.set(
          "Cookie",
          Array.from(cookies, ([name, value]) => `${name}=${value}`).join("; "),
        );
      const response = await fetch(url, { ...init, headers });
      const getSetCookie = (response.headers as Headers & {
        getSetCookie?: () => string[];
      }).getSetCookie;
      for (const value of getSetCookie?.call(response.headers) ?? []) {
        const [pair] = value.split(";", 1);
        const separator = pair?.indexOf("=") ?? -1;
        if (pair && separator > 0)
          cookies.set(pair.slice(0, separator), pair.slice(separator + 1));
      }
      return response;
    };
    const client = () => new AtlasClient({ fetch: browserFetch });
    const controller = new AtlasTransferController(prepared(), {
      client: client(),
      pollDelay: (signal) =>
        new Promise((resolve, reject) => {
          const timer = setTimeout(resolve, 100);
          signal.addEventListener(
            "abort",
            () => {
              clearTimeout(timer);
              reject(signal.reason);
            },
            { once: true },
          );
        }),
    });
    const first = controller.start({
      operatorToken: operatorToken!,
      title: "BSD-03 isolated contiguous acceptance fixture",
      sourceKind: "synthetic",
      analyzeAfterSave: true,
    });
    const duplicate = controller.start({
      operatorToken: operatorToken!,
      title: "BSD-03 isolated contiguous acceptance fixture",
      sourceKind: "synthetic",
      analyzeAfterSave: true,
    });
    expect(duplicate).toBe(first);
    const saved = await first;
    expect(injectedLoss).toBe(true);
    expect(saved.analysis.status).toBe("scheduled");
    const run = saved.analysis.run;
    expect(run).toBeDefined();
    if (!run) throw new Error("SigIntAtlas did not return the scheduled run.");
    expect(run.recording_revision_id).toBe(saved.recordingRevisionId);
    expect(saved.recordingUrl).toBe(`/#/recordings/${saved.recordingId}`);
    expect(run.result_url).toBe(`/#/runs/${run.id}`);

    const expectedData = Uint8Array.from(
      Buffer.from(fixture.data_base64, "base64"),
    );
    for (const role of ["data", "metadata"] as const) {
      const download = await browserFetch(
        `/api/v1/recordings/${saved.recordingId}/files/${role}?revision_id=${saved.recordingRevisionId}`,
      );
      expect(download.status).toBe(200);
      const bytes = new Uint8Array(await download.arrayBuffer());
      const expected =
        role === "data"
          ? expectedData
          : new TextEncoder().encode(
              `${JSON.stringify(fixture.metadata, null, 2)}\n`,
            );
      expect(bytes).toEqual(expected);
      expect(createHash("sha256").update(bytes).digest("hex")).toBe(
        role === "data" ? saved.dataSha256 : saved.metadataSha256,
      );
    }
    const reopenedRecording = await browserFetch(
      `/api/v1/recordings/${saved.recordingId}`,
    );
    const reopenedRun = await browserFetch(
      `/api/v1/runs/${run.id}`,
    );
    expect(reopenedRecording.status).toBe(200);
    expect(reopenedRun.status).toBe(200);

    const gapMetadata = structuredClone(fixture.metadata) as typeof fixture.metadata;
    gapMetadata.captures.push({
      ...gapMetadata.captures[0]!,
      "core:sample_start": 32,
      "core:global_index": 40,
    });
    const gapController = new AtlasTransferController(
      prepared(gapMetadata, "structured-gap"),
      { client: client(), pollDelay: async () => undefined },
    );
    const gap = await gapController.start({
      operatorToken: operatorToken!,
      title: "BSD-03 isolated structured-gap archive fixture",
      sourceKind: "synthetic",
      analyzeAfterSave: true,
    });
    expect(gap.analysis.status).toBe("unavailable");
    expect(gap.compatibility.analysisEligible).toBe(false);
    expect(gap.compatibility.issues.map((issue) => issue.code)).toContain(
      "structured_gap_unsupported",
    );
    expect(analysisCreates).toBe(1);
  });
});

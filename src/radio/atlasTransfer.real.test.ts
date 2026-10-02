import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import fixture from "../../docs/implementation/atlas-integration/fixtures/browsersdr-cu8-v1.json";
import { AtlasClient } from "./atlasClient";
import { AtlasTransferController } from "./atlasTransfer";
import type { PreparedRecordingExport } from "./recordingExportFormat";

const baseUrl = process.env.SIGNAL_ATLAS_BSD02_BASE_URL;
const operatorToken = process.env.SIGNAL_ATLAS_BSD02_OPERATOR_TOKEN;
const configured = Boolean(baseUrl && operatorToken);

describe.skipIf(!configured)("configured real SigIntAtlas transfer", () => {
  it("retries one injected part loss, saves one pair, and downloads identical original bytes", async () => {
    const origin = new URL(baseUrl!).origin;
    const cookies = new Map<string, string>();
    let injectedLoss = false;
    const browserFetch: typeof fetch = async (input, init = {}) => {
      const url = new URL(String(input), origin);
      if (!injectedLoss && /\/uploads\/[^/]+\/parts\/\d+$/.test(url.pathname)) {
        injectedLoss = true;
        throw new TypeError("BSD-02 injected pre-request network loss");
      }
      const headers = new Headers(init.headers);
      headers.set("Origin", origin);
      if (cookies.size) headers.set("Cookie", Array.from(cookies, ([name, value]) => `${name}=${value}`).join("; "));
      const result = await fetch(url, { ...init, headers });
      const getSetCookie = (result.headers as Headers & { getSetCookie?: () => string[] }).getSetCookie;
      const values = getSetCookie ? getSetCookie.call(result.headers) : [];
      for (const value of values) {
        const [pair] = value.split(";", 1), separator = pair?.indexOf("=") ?? -1;
        if (pair && separator > 0) cookies.set(pair.slice(0, separator), pair.slice(separator + 1));
      }
      return result;
    };
    const data = Uint8Array.from(Buffer.from(fixture.data_base64, "base64"));
    const metadata = `${JSON.stringify(fixture.metadata, null, 2)}\n`;
    const prepared: PreparedRecordingExport = {
      format: "sigmf", basename: fixture.basename, sampleCount: Number(fixture.data_byte_length) / 2,
      files: [
        { name: `${fixture.basename}.sigmf-data`, contents: data, type: "application/octet-stream" },
        { name: `${fixture.basename}.sigmf-meta`, contents: metadata, type: "application/json" },
      ],
    };
    const controller = new AtlasTransferController(prepared, {
      client: new AtlasClient({ fetch: browserFetch }),
      pollDelay: signal => new Promise((resolve, reject) => {
        const timer = setTimeout(resolve, 100);
        signal.addEventListener("abort", () => { clearTimeout(timer); reject(signal.reason); }, { once: true });
      }),
    });
    const saved = await controller.start({ userToken: operatorToken!, title: "BSD-02 isolated real-backend fixture", sourceKind: "synthetic" });
    expect(injectedLoss).toBe(true);
    expect(saved.dataSha256).toBe(fixture.data_sha256);
    const download = await browserFetch(`/api/v1/recordings/${saved.recordingId}/files/data?revision_id=${saved.recordingRevisionId}`);
    expect(download.status).toBe(200);
    const downloaded = new Uint8Array(await download.arrayBuffer());
    expect(createHash("sha256").update(downloaded).digest("hex")).toBe(fixture.data_sha256);
    expect(downloaded).toEqual(data);
  });
});

import { sha512Hex, type SigmfMetadata } from "./sigmf";

export const ATLAS_INTEGRATION_CONTRACT_VERSION = "signalexplorer-browsersdr-integration-v1" as const;
export const ATLAS_INTEGRATION_SCHEMA_DIGEST_SHA256 = "d00c6936ef6d743584eaf686a8ace0c72ff4bf286255e7b4d77fbeda8f6ef164" as const;
export const ATLAS_INTEGRATION_SCHEMA_ARTIFACT_SHA256 = "db022c55f8619a9850561bbe45112656cbd9fa1b63981bf06ed2b9111470f7ff" as const;

export type AtlasSigmfIssueCode =
  | "datatype_unsupported"
  | "integrity_failed"
  | "layout_invalid"
  | "structured_gap_unsupported";

export interface AtlasSigmfIssue {
  code: AtlasSigmfIssueCode;
  message: string;
}

export interface AtlasSigmfCompatibility {
  contractVersion: typeof ATLAS_INTEGRATION_CONTRACT_VERSION;
  schemaDigestSha256: typeof ATLAS_INTEGRATION_SCHEMA_DIGEST_SHA256;
  archiveEligible: boolean;
  analysisEligible: boolean;
  quarantine: boolean;
  byteLength: string;
  sampleCount: string;
  computedSha512: string;
  issues: AtlasSigmfIssue[];
}

export type AtlasSigmfLayoutCompatibility = Omit<AtlasSigmfCompatibility, "computedSha512" | "quarantine">;

export function inspectBrowserSigmfLayoutForAtlas(metadata: SigmfMetadata, dataByteLength: number): AtlasSigmfLayoutCompatibility {
  const issues: AtlasSigmfIssue[] = [];
  const sampleCount = dataByteLength / 2;
  if (!Number.isSafeInteger(sampleCount) || sampleCount <= 0) {
    issues.push({ code: "layout_invalid", message: "The dataset must contain complete, non-empty interleaved I/Q pairs." });
  }
  let previousStart = -1;
  for (const capture of metadata.captures) {
    const start = capture["core:sample_start"];
    if (!Number.isSafeInteger(start) || start < 0 || start > sampleCount || start <= previousStart) {
      issues.push({ code: "layout_invalid", message: "Capture starts must be strictly increasing and within the dataset." });
      break;
    }
    previousStart = start;
    const globalIndex = capture["core:global_index"];
    if (globalIndex !== undefined && globalIndex !== start) {
      issues.push({ code: "structured_gap_unsupported", message: "A capture global index declares a structured gap." });
    }
  }
  if (metadata.captures.length === 0 || metadata.captures[0]?.["core:sample_start"] !== 0) {
    issues.push({ code: "layout_invalid", message: "BrowserSDR exports require a first capture at sample zero." });
  }
  for (const annotation of metadata.annotations) {
    const start = annotation["core:sample_start"], count = annotation["core:sample_count"];
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(count) || start < 0 || count < 0 || start + count > sampleCount) {
      issues.push({ code: "layout_invalid", message: "An annotation range lies outside the exact dataset sample range." });
      break;
    }
    if (annotation["core:generator"] === "BrowserSDR" && annotation["core:label"] === "gap") {
      issues.push({ code: "structured_gap_unsupported", message: "A BrowserSDR gap annotation makes the original archive-only, including when its duration is unknown." });
    }
  }
  if (metadata.global["core:datatype"] !== "cu8") {
    issues.push({ code: "datatype_unsupported", message: "First-release SignalExplorer analysis does not support BrowserSDR native ci8." });
  }
  const uniqueIssues = issues.filter((issue, index) => issues.findIndex(candidate => candidate.code === issue.code) === index);
  const invalid = uniqueIssues.some(issue => issue.code === "layout_invalid");
  return {
    contractVersion: ATLAS_INTEGRATION_CONTRACT_VERSION,
    schemaDigestSha256: ATLAS_INTEGRATION_SCHEMA_DIGEST_SHA256,
    archiveEligible: !invalid,
    analysisEligible: uniqueIssues.length === 0,
    byteLength: String(dataByteLength),
    sampleCount: String(Number.isInteger(sampleCount) ? sampleCount : Math.floor(sampleCount)),
    issues: uniqueIssues,
  };
}

/**
 * Inspect one pair produced by BrowserSDR. This is deliberately narrower than
 * Atlas's general SigMF parser: it prevents a future transfer client from
 * confusing a successful archive with first-release analysis eligibility.
 */
export async function inspectBrowserSigmfForAtlas(
  metadata: SigmfMetadata,
  data: Uint8Array,
): Promise<AtlasSigmfCompatibility> {
  const layout = inspectBrowserSigmfLayoutForAtlas(metadata, data.byteLength);
  const issues = [...layout.issues];
  const computedSha512 = await sha512Hex(data);
  const declaredSha512 = metadata.global["core:sha512"].toLowerCase();

  if (computedSha512 !== declaredSha512) {
    issues.push({ code: "integrity_failed", message: "The declared SigMF SHA-512 does not match the exact dataset bytes." });
  }

  const uniqueIssues = issues.filter((issue, index) =>
    issues.findIndex((candidate) => candidate.code === issue.code) === index,
  );
  const quarantine = uniqueIssues.some((issue) => issue.code === "integrity_failed");
  const invalid = uniqueIssues.some((issue) => issue.code === "layout_invalid");
  return {
    contractVersion: ATLAS_INTEGRATION_CONTRACT_VERSION,
    schemaDigestSha256: ATLAS_INTEGRATION_SCHEMA_DIGEST_SHA256,
    archiveEligible: !quarantine && !invalid,
    analysisEligible: uniqueIssues.length === 0,
    quarantine,
    byteLength: layout.byteLength,
    sampleCount: layout.sampleCount,
    computedSha512,
    issues: uniqueIssues,
  };
}

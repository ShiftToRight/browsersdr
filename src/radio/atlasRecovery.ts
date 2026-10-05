import type { AtlasTransferRequest, AtlasTransferResult } from "./atlasTransfer";
import type { AtlasSigmfLayoutCompatibility } from "./atlasSigmfCompatibility";

export interface ReceiptFile { name: string; size: number; sha256: string; partSize: number; }
export interface AtlasRecoveryReceipt {
  version: 1;
  pairId: string;
  operatorId: string;
  startedAt: string;
  verificationStartedAt?: string;
  request: Omit<AtlasTransferRequest, "userToken">;
  files: Record<"data" | "metadata", ReceiptFile>;
  compatibility: AtlasSigmfLayoutCompatibility;
  uploads: Partial<Record<"data" | "metadata", string>>;
  attempts: Record<"data" | "metadata", number>;
  jobs: Partial<Record<"data" | "metadata", string>>;
  registrationId?: string;
  result?: AtlasTransferResult;
}
export type ReceiptStorage = Pick<Storage, "getItem" | "setItem">;
const KEY = "browsersdr.atlas.receipts.v1";
export function browserReceiptStorage(): ReceiptStorage | null {
  try { return typeof localStorage === "undefined" ? null : localStorage; } catch { return null; }
}
export function readAtlasReceipts(storage = browserReceiptStorage()): AtlasRecoveryReceipt[] {
  try {
    const values: unknown = JSON.parse(storage?.getItem(KEY) ?? "[]");
    if (!Array.isArray(values)) return [];
    return values.filter((value): value is AtlasRecoveryReceipt => {
      if (!value || value.version !== 1 || typeof value.pairId !== "string" || value.pairId.length > 100 || typeof value.operatorId !== "string" || !Number.isFinite(Date.parse(value.startedAt)) || typeof value.request?.title !== "string" || value.request.title.length > 200 || !["real", "synthetic", "unknown"].includes(value.request.sourceKind) || !value.uploads || !value.attempts || !value.jobs || !value.compatibility) return false;
      return ["data", "metadata"].every(role => {
        const file = value.files?.[role];
        return file && typeof file.name === "string" && file.name.length <= 400 && /^[a-f0-9]{64}$/.test(file.sha256) && Number.isSafeInteger(file.size) && file.size > 0 && Number.isSafeInteger(file.partSize) && file.partSize > 0;
      });
    }).slice(-20);
  } catch { return []; }
}
export function saveAtlasReceipt(value: AtlasRecoveryReceipt, storage = browserReceiptStorage()): boolean {
  if (!storage) return false;
  try {
    const receipts = readAtlasReceipts(storage).filter(item => item.pairId !== value.pairId);
    storage.setItem(KEY, JSON.stringify([...receipts, value].slice(-20)));
    if (typeof window !== "undefined") window.dispatchEvent(new Event("browsersdr-atlas-recovery"));
    return true;
  } catch { return false; }
}

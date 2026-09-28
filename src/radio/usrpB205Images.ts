import { unzipSync } from "fflate";

export interface UsrpB205ImageContract {
  readonly uhdVersion: "4.9.0.0";
  readonly uhdCommit: "006d7f7646fb66f2ae635cb44ef6442a6ad4fba7";
  readonly sourceId: "uhd-c37b318";
  readonly manifestTarget: "b2xx_b205mini_fpga_default";
  readonly archiveFilename: "b2xx_b205mini_fpga_default-gc37b318.zip";
  readonly archiveUrl: string;
  readonly archiveSha256: string;
  readonly memberFilename: "usrp_b205mini_fpga.bin";
  readonly memberByteLength: number;
  readonly memberSha256: string;
  readonly legacyHash: number;
  readonly fpgaCompatibility: "7.0";
  readonly reservedPublicUrl: string;
  readonly redistribution: "not-approved-user-import-only";
  readonly licenseNotice: string;
}

export const USRP_B205_IMAGE: UsrpB205ImageContract = Object.freeze({
  uhdVersion: "4.9.0.0",
  uhdCommit: "006d7f7646fb66f2ae635cb44ef6442a6ad4fba7",
  sourceId: "uhd-c37b318",
  manifestTarget: "b2xx_b205mini_fpga_default",
  archiveFilename: "b2xx_b205mini_fpga_default-gc37b318.zip",
  archiveUrl: "https://files.ettus.com/binaries/cache/b2xx/uhd-c37b318/b2xx_b205mini_fpga_default-gc37b318.zip",
  archiveSha256: "dce96120e3512d6e21bb061811c4021cbc90ac4d787248ad821337b7389ff3c4",
  memberFilename: "usrp_b205mini_fpga.bin",
  memberByteLength: 4_223_252,
  memberSha256: "f4da0becf906af957c954a7a1c276aa91f79ca369d7aedf7c2f5c7fdebf4c351",
  legacyHash: 0x1624155e,
  fpgaCompatibility: "7.0",
  reservedPublicUrl: "/assets/usrp-b205/uhd-4.9.0.0/usrp_b205mini_fpga.bin",
  redistribution: "not-approved-user-import-only",
  licenseNotice: "The official Ettus FPGA binary is not redistributed. Users import the pinned official archive/member; future redistribution requires the PROTOCOL.md LGPL/third-party review.",
});

export interface VerifiedUsrpB205Image {
  readonly contract: UsrpB205ImageContract;
  readonly bytes: Uint8Array;
  readonly importedAs: "official-archive" | "official-member";
  readonly archiveSha256: string | null;
  readonly memberSha256: string;
  readonly legacyHash: number;
}

interface StoredUsrpB205Image {
  sha256: string;
  bytes: ArrayBuffer;
  storedAt: number;
  importedAs: VerifiedUsrpB205Image["importedAs"];
  archiveSha256: string | null;
}

export type Sha256 = (bytes: Uint8Array) => Promise<string>;

function hex(bytes: Uint8Array): string {
  return [...bytes].map((value) => value.toString(16).padStart(2, "0")).join("");
}

export const sha256: Sha256 = async (bytes) => {
  const owned = Uint8Array.from(bytes);
  return hex(new Uint8Array(await crypto.subtle.digest("SHA-256", owned.buffer)));
};

/** UHD's pinned signed-byte Boost hash-combine cache value, with u32 wrapping. */
export function usrpB205LegacyHash(bytes: Uint8Array): number {
  let hash = 0;
  for (const byte of bytes) {
    const signed = byte < 0x80 ? byte : byte - 0x100;
    hash = (hash ^ (signed + 0x9e3779b9 + (hash << 6) + (hash >>> 2))) >>> 0;
  }
  return hash;
}

export async function verifyUsrpB205Member(
  input: ArrayBuffer | Uint8Array,
  contract: UsrpB205ImageContract = USRP_B205_IMAGE,
  digest: Sha256 = sha256,
): Promise<Uint8Array> {
  const bytes = Uint8Array.from(input instanceof Uint8Array ? input : new Uint8Array(input));
  if (bytes.byteLength !== contract.memberByteLength) {
    throw new Error(`USRP B205-mini FPGA image has ${bytes.byteLength} bytes; expected ${contract.memberByteLength}.`);
  }
  const actualSha256 = await digest(bytes);
  if (actualSha256 !== contract.memberSha256) {
    throw new Error("USRP B205-mini FPGA image SHA-256 does not match the pinned official member.");
  }
  const actualLegacyHash = usrpB205LegacyHash(bytes);
  if (actualLegacyHash !== contract.legacyHash) {
    throw new Error("USRP B205-mini FPGA image legacy hash does not match the pinned official member.");
  }
  return bytes;
}

export async function verifyUsrpB205Import(
  filename: string,
  input: ArrayBuffer | Uint8Array,
  contract: UsrpB205ImageContract = USRP_B205_IMAGE,
  digest: Sha256 = sha256,
): Promise<VerifiedUsrpB205Image> {
  const inputBytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  let member: Uint8Array;
  let importedAs: VerifiedUsrpB205Image["importedAs"];
  let archiveSha256: string | null = null;
  if (filename === contract.archiveFilename) {
    archiveSha256 = await digest(inputBytes);
    if (archiveSha256 !== contract.archiveSha256) {
      throw new Error("USRP B205-mini FPGA archive SHA-256 does not match the pinned official archive.");
    }
    let files: Record<string, Uint8Array>;
    try {
      files = unzipSync(inputBytes);
    } catch (error) {
      throw new Error("USRP B205-mini FPGA archive is not a valid ZIP file.", { cause: error });
    }
    member = files[contract.memberFilename]!;
    if (!member) throw new Error(`USRP B205-mini FPGA archive does not contain ${contract.memberFilename}.`);
    importedAs = "official-archive";
  } else if (filename === contract.memberFilename) {
    member = inputBytes;
    importedAs = "official-member";
  } else {
    throw new Error(`Import ${contract.archiveFilename} or ${contract.memberFilename}; no other FPGA image is supported.`);
  }
  const bytes = await verifyUsrpB205Member(member, contract, digest);
  return {
    contract,
    bytes,
    importedAs,
    archiveSha256,
    memberSha256: contract.memberSha256,
    legacyHash: contract.legacyHash,
  };
}

const DATABASE_NAME = "browsersdr-usrp-b205-images";
const DATABASE_VERSION = 2;
const IMAGE_STORE = "verified-images";

function openDatabase(): Promise<IDBDatabase> {
  if (typeof indexedDB === "undefined") return Promise.reject(new Error("This browser does not provide local FPGA image storage."));
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(IMAGE_STORE)) request.result.createObjectStore(IMAGE_STORE, { keyPath: "sha256" });
      if (!request.result.objectStoreNames.contains("verified-firmware")) request.result.createObjectStore("verified-firmware", { keyPath: "sha256" });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("Could not open USRP FPGA image storage."));
    request.onblocked = () => reject(new Error("USRP FPGA image storage is blocked by another page."));
  });
}

export async function importUsrpB205Image(file: File): Promise<VerifiedUsrpB205Image> {
  const verified = await verifyUsrpB205Import(file.name, await file.arrayBuffer());
  const database = await openDatabase();
  try {
    await new Promise<void>((resolve, reject) => {
      const transaction = database.transaction(IMAGE_STORE, "readwrite");
      transaction.objectStore(IMAGE_STORE).put({
        sha256: verified.memberSha256,
        bytes: Uint8Array.from(verified.bytes).buffer,
        storedAt: Date.now(),
        importedAs: verified.importedAs,
        archiveSha256: verified.archiveSha256,
      } satisfies StoredUsrpB205Image);
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error ?? new Error("Could not save the USRP FPGA image."));
      transaction.onabort = () => reject(transaction.error ?? new Error("Saving the USRP FPGA image was aborted."));
    });
  } finally {
    database.close();
  }
  try { await navigator.storage?.persist?.(); } catch { /* Persistence is optional. */ }
  return verified;
}

export async function loadStoredUsrpB205Image(): Promise<VerifiedUsrpB205Image> {
  const database = await openDatabase();
  let stored: StoredUsrpB205Image | undefined;
  try {
    stored = await new Promise((resolve, reject) => {
      const request = database.transaction(IMAGE_STORE, "readonly").objectStore(IMAGE_STORE).get(USRP_B205_IMAGE.memberSha256);
      request.onsuccess = () => resolve(request.result as StoredUsrpB205Image | undefined);
      request.onerror = () => reject(request.error ?? new Error("Could not read the USRP FPGA image."));
    });
  } finally {
    database.close();
  }
  if (!stored) throw new Error(`USRP B205-mini needs ${USRP_B205_IMAGE.archiveFilename} or ${USRP_B205_IMAGE.memberFilename}. Import the official file before connecting; the device was not modified.`);
  try {
    const bytes = await verifyUsrpB205Member(stored.bytes);
    return { contract: USRP_B205_IMAGE, bytes, importedAs: stored.importedAs,
      archiveSha256: stored.archiveSha256, memberSha256: USRP_B205_IMAGE.memberSha256,
      legacyHash: USRP_B205_IMAGE.legacyHash };
  } catch (error) {
    throw new Error("The saved USRP B205-mini FPGA image failed verification. Import a fresh official copy before reconnecting; the device was not modified.", { cause: error });
  }
}

import { unzipSync } from "fflate";
import { sha256, type Sha256 } from "./usrpB205Images";

export interface UsrpB205FirmwareContract {
  readonly uhdVersion: "4.9.0.0";
  readonly uhdCommit: "006d7f7646fb66f2ae635cb44ef6442a6ad4fba7";
  readonly sourceId: "uhd-7f7d016";
  readonly manifestTarget: "b2xx_common_fw_default";
  readonly archiveFilename: "b2xx_common_fw_default-g7f7d016.zip";
  readonly archiveUrl: string;
  readonly archiveSha256: string;
  readonly memberFilename: "usrp_b200_fw.hex";
  readonly memberByteLength: 514_346;
  readonly memberSha256: string;
  readonly entryAddress: 0x40019dec;
  readonly redistribution: "not-approved-user-import-only";
}

export const USRP_B205_FIRMWARE: UsrpB205FirmwareContract = Object.freeze({
  uhdVersion: "4.9.0.0",
  uhdCommit: "006d7f7646fb66f2ae635cb44ef6442a6ad4fba7",
  sourceId: "uhd-7f7d016",
  manifestTarget: "b2xx_common_fw_default",
  archiveFilename: "b2xx_common_fw_default-g7f7d016.zip",
  archiveUrl: "https://files.ettus.com/binaries/cache/b2xx/uhd-7f7d016/b2xx_common_fw_default-g7f7d016.zip",
  archiveSha256: "22ac0e54cc90d53d8494d481439447a0c89b9bbaced6fabe24df260eda3ce3a3",
  memberFilename: "usrp_b200_fw.hex",
  memberByteLength: 514_346,
  memberSha256: "cc8e4bc968d91d1a67c63871ce5b2c1613c49676fe363bf2f6e336059899ae5c",
  entryAddress: 0x40019dec,
  redistribution: "not-approved-user-import-only",
});

export interface UsrpB205FirmwareWrite {
  readonly address: number;
  readonly bytes: Uint8Array;
  readonly execute: boolean;
}

export interface VerifiedUsrpB205Firmware {
  readonly contract: UsrpB205FirmwareContract;
  readonly text: string;
  readonly importedAs: "official-archive" | "official-member";
  readonly archiveSha256: string | null;
  readonly memberSha256: string;
}

function byteAt(value: string, offset: number): number {
  const pair = value.slice(offset, offset + 2);
  if (!/^[0-9a-fA-F]{2}$/.test(pair)) throw new Error("USRP FX3 firmware contains malformed Intel HEX digits.");
  return Number.parseInt(pair, 16);
}

/** Strict Intel HEX subset used by the pinned UHD FX3 image. */
export function parseUsrpB205Firmware(text: string): readonly UsrpB205FirmwareWrite[] {
  const lines = text.trim().split(/\r?\n/);
  if (lines.length < 2 || lines.length > 20_000) throw new Error("USRP FX3 firmware has an invalid Intel HEX record count.");
  const writes: UsrpB205FirmwareWrite[] = [];
  let upper = 0;
  let eof = false;
  let entrySeen = false;
  let dataBytes = 0;
  for (const [index, line] of lines.entries()) {
    if (eof) throw new Error("USRP FX3 firmware contains records after Intel HEX EOF.");
    if (!line.startsWith(":")) throw new Error(`USRP FX3 firmware record ${index + 1} is missing ':'.`);
    const length = byteAt(line, 1);
    const expectedCharacters = 11 + length * 2;
    if (line.length !== expectedCharacters) throw new Error(`USRP FX3 firmware record ${index + 1} has an invalid length.`);
    let checksum = 0;
    for (let offset = 1; offset < line.length; offset += 2) checksum = (checksum + byteAt(line, offset)) & 0xff;
    if (checksum !== 0) throw new Error(`USRP FX3 firmware record ${index + 1} has an invalid checksum.`);
    const lower = (byteAt(line, 3) << 8) | byteAt(line, 5);
    const type = byteAt(line, 7);
    const data = new Uint8Array(length);
    for (let offset = 0; offset < length; offset += 1) data[offset] = byteAt(line, 9 + offset * 2);
    if (type === 0x00) {
      const address = upper * 0x1_0000 + lower;
      if (!Number.isSafeInteger(address) || address + length > 0x1_0000_0000)
        throw new Error("USRP FX3 firmware contains an out-of-range address.");
      dataBytes += length;
      if (dataBytes > 512 * 1024) throw new Error("USRP FX3 firmware payload exceeds the pinned bound.");
      writes.push({ address, bytes: data, execute: false });
    } else if (type === 0x01) {
      if (length !== 0 || lower !== 0) throw new Error("USRP FX3 firmware has a malformed EOF record.");
      eof = true;
    } else if (type === 0x04) {
      if (length !== 2 || lower !== 0) throw new Error("USRP FX3 firmware has a malformed extended address record.");
      upper = (data[0]! << 8) | data[1]!;
    } else if (type === 0x05) {
      if (length !== 4 || lower !== 0 || entrySeen) throw new Error("USRP FX3 firmware has a malformed start-address record.");
      const address = new DataView(data.buffer).getUint32(0, false);
      if (address !== USRP_B205_FIRMWARE.entryAddress) throw new Error("USRP FX3 firmware start address does not match the pinned image.");
      writes.push({ address, bytes: new Uint8Array(), execute: true });
      entrySeen = true;
    } else {
      throw new Error(`USRP FX3 firmware uses unsupported Intel HEX record type 0x${type.toString(16)}.`);
    }
  }
  if (!eof || !entrySeen || dataBytes === 0) throw new Error("USRP FX3 firmware is missing data, start, or EOF records.");
  return writes;
}

export async function verifyUsrpB205FirmwareImport(
  filename: string,
  input: ArrayBuffer | Uint8Array,
  digest: Sha256 = sha256,
): Promise<VerifiedUsrpB205Firmware> {
  const inputBytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  let member: Uint8Array;
  let importedAs: VerifiedUsrpB205Firmware["importedAs"];
  let archiveSha256: string | null = null;
  if (filename === USRP_B205_FIRMWARE.archiveFilename) {
    archiveSha256 = await digest(inputBytes);
    if (archiveSha256 !== USRP_B205_FIRMWARE.archiveSha256) throw new Error("USRP FX3 firmware archive SHA-256 does not match the pinned official archive.");
    let files: Record<string, Uint8Array>;
    try { files = unzipSync(inputBytes); }
    catch (error) { throw new Error("USRP FX3 firmware archive is not a valid ZIP file.", { cause: error }); }
    member = files[USRP_B205_FIRMWARE.memberFilename]!;
    if (!member) throw new Error(`USRP FX3 firmware archive does not contain ${USRP_B205_FIRMWARE.memberFilename}.`);
    importedAs = "official-archive";
  } else if (filename === USRP_B205_FIRMWARE.memberFilename) {
    member = inputBytes;
    importedAs = "official-member";
  } else {
    throw new Error(`Import ${USRP_B205_FIRMWARE.archiveFilename} or ${USRP_B205_FIRMWARE.memberFilename}; no other FX3 firmware is supported.`);
  }
  if (member.byteLength !== USRP_B205_FIRMWARE.memberByteLength) throw new Error(`USRP FX3 firmware has ${member.byteLength} bytes; expected ${USRP_B205_FIRMWARE.memberByteLength}.`);
  if (await digest(member) !== USRP_B205_FIRMWARE.memberSha256) throw new Error("USRP FX3 firmware SHA-256 does not match the pinned official member.");
  const text = new TextDecoder("ascii", { fatal: true }).decode(member);
  parseUsrpB205Firmware(text);
  return { contract: USRP_B205_FIRMWARE, text, importedAs, archiveSha256, memberSha256: USRP_B205_FIRMWARE.memberSha256 };
}

interface StoredFirmware { sha256: string; text: string; importedAs: VerifiedUsrpB205Firmware["importedAs"]; archiveSha256: string | null; storedAt: number }
const DATABASE_NAME = "browsersdr-usrp-b205-images";
const DATABASE_VERSION = 2;
const FIRMWARE_STORE = "verified-firmware";

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains("verified-images")) request.result.createObjectStore("verified-images", { keyPath: "sha256" });
      if (!request.result.objectStoreNames.contains(FIRMWARE_STORE)) request.result.createObjectStore(FIRMWARE_STORE, { keyPath: "sha256" });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("Could not open USRP firmware storage."));
  });
}

export async function importUsrpB205Firmware(file: File): Promise<VerifiedUsrpB205Firmware> {
  const verified = await verifyUsrpB205FirmwareImport(file.name, await file.arrayBuffer());
  const database = await openDatabase();
  try {
    await new Promise<void>((resolve, reject) => {
      const transaction = database.transaction(FIRMWARE_STORE, "readwrite");
      transaction.objectStore(FIRMWARE_STORE).put({ sha256: verified.memberSha256, text: verified.text, importedAs: verified.importedAs, archiveSha256: verified.archiveSha256, storedAt: Date.now() } satisfies StoredFirmware);
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error ?? new Error("Could not save USRP firmware."));
    });
  } finally { database.close(); }
  return verified;
}

export async function loadStoredUsrpB205Firmware(): Promise<VerifiedUsrpB205Firmware> {
  const database = await openDatabase();
  try {
    const stored = await new Promise<StoredFirmware | undefined>((resolve, reject) => {
      const request = database.transaction(FIRMWARE_STORE, "readonly").objectStore(FIRMWARE_STORE).get(USRP_B205_FIRMWARE.memberSha256);
      request.onsuccess = () => resolve(request.result as StoredFirmware | undefined);
      request.onerror = () => reject(request.error ?? new Error("Could not read USRP firmware."));
    });
    if (!stored) throw new Error(`Import ${USRP_B205_FIRMWARE.archiveFilename} or ${USRP_B205_FIRMWARE.memberFilename} before connecting.`);
    const bytes = new TextEncoder().encode(stored.text);
    return verifyUsrpB205FirmwareImport(USRP_B205_FIRMWARE.memberFilename, bytes);
  } finally { database.close(); }
}

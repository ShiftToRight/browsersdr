import { existsSync, readFileSync } from "node:fs";
import { zipSync } from "fflate";
import { describe, expect, it } from "vitest";
import {
  USRP_B205_IMAGE,
  sha256,
  usrpB205LegacyHash,
  verifyUsrpB205Import,
  verifyUsrpB205Member,
  type UsrpB205ImageContract,
} from "./usrpB205Images";

describe("USRP B205-mini FPGA provenance and verification", () => {
  it("pins the official archive/member provenance without redistributing the binary", () => {
    expect(USRP_B205_IMAGE).toMatchObject({
      uhdVersion: "4.9.0.0",
      uhdCommit: "006d7f7646fb66f2ae635cb44ef6442a6ad4fba7",
      sourceId: "uhd-c37b318",
      archiveSha256: "dce96120e3512d6e21bb061811c4021cbc90ac4d787248ad821337b7389ff3c4",
      memberFilename: "usrp_b205mini_fpga.bin",
      memberByteLength: 4_223_252,
      memberSha256: "f4da0becf906af957c954a7a1c276aa91f79ca369d7aedf7c2f5c7fdebf4c351",
      legacyHash: 0x1624155e,
      redistribution: "not-approved-user-import-only",
    });
    const provenance = JSON.parse(readFileSync("public/assets/usrp-b205/uhd-4.9.0.0/provenance.json", "utf8")) as Record<string, unknown>;
    expect(provenance).toMatchObject({ redistributed: false, memberSha256: USRP_B205_IMAGE.memberSha256 });
    expect(existsSync(`public${USRP_B205_IMAGE.reservedPublicUrl}`)).toBe(false);
  });

  it("matches the pinned signed-byte legacy hash golden vector", () => {
    expect(usrpB205LegacyHash(Uint8Array.of(0x00, 0x7f, 0x80, 0xff))).toBe(0x484552d4);
  });

  it("verifies both a pinned member and its exact archive before returning owned bytes", async () => {
    const member = Uint8Array.of(0x00, 0x7f, 0x80, 0xff);
    const archive = zipSync({ "usrp_b205mini_fpga.bin": member });
    const contract: UsrpB205ImageContract = {
      ...USRP_B205_IMAGE,
      memberByteLength: member.byteLength,
      memberSha256: await sha256(member),
      legacyHash: usrpB205LegacyHash(member),
      archiveSha256: await sha256(archive),
    };
    const raw = await verifyUsrpB205Import(contract.memberFilename, member, contract);
    const zipped = await verifyUsrpB205Import(contract.archiveFilename, archive, contract);
    expect(raw).toMatchObject({ importedAs: "official-member", archiveSha256: null, legacyHash: contract.legacyHash });
    expect(zipped).toMatchObject({ importedAs: "official-archive", archiveSha256: contract.archiveSha256 });
    member[0] = 99;
    expect([...raw.bytes]).toEqual([0, 127, 128, 255]);
    expect([...zipped.bytes]).toEqual([0, 127, 128, 255]);
  });

  it("rejects wrong name, size, archive digest, member digest and legacy hash", async () => {
    const bytes = Uint8Array.of(1, 2, 3);
    const digest = await sha256(bytes);
    const contract: UsrpB205ImageContract = { ...USRP_B205_IMAGE, memberByteLength: 3, memberSha256: digest, legacyHash: usrpB205LegacyHash(bytes) };
    await expect(verifyUsrpB205Import("other.bin", bytes, contract)).rejects.toThrow(/no other FPGA/);
    await expect(verifyUsrpB205Member(Uint8Array.of(1, 2), contract)).rejects.toThrow(/2 bytes/);
    await expect(verifyUsrpB205Member(bytes, { ...contract, memberSha256: "0".repeat(64) })).rejects.toThrow(/SHA-256/);
    await expect(verifyUsrpB205Member(bytes, { ...contract, legacyHash: 0 })).rejects.toThrow(/legacy hash/);
    const archive = zipSync({ "usrp_b205mini_fpga.bin": bytes });
    await expect(verifyUsrpB205Import(contract.archiveFilename, archive, contract)).rejects.toThrow(/archive SHA-256/);
  });
});

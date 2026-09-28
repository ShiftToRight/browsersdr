import { describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { parseUsrpB205Firmware, verifyUsrpB205FirmwareImport, USRP_B205_FIRMWARE } from "./usrpB205Firmware";

function record(type: number, address: number, data: readonly number[]): string {
  const bytes = [data.length, address >>> 8, address & 0xff, type, ...data];
  const checksum = (-bytes.reduce((sum, value) => sum + value, 0)) & 0xff;
  return `:${[...bytes, checksum].map((value) => value.toString(16).padStart(2, "0")).join("").toUpperCase()}`;
}

function fixture(): string {
  return [
    record(0x04, 0, [0x40, 0x01]),
    record(0x00, 0x0100, [1, 2, 3, 4]),
    record(0x05, 0, [0x40, 0x01, 0x9d, 0xec]),
    record(0x01, 0, []),
  ].join("\n");
}

describe("B205-mini FX3 firmware import", () => {
  it("pins official provenance without redistributing the firmware", () => {
    const provenance = JSON.parse(
      readFileSync("public/assets/usrp-b205/uhd-4.9.0.0/firmware-provenance.json", "utf8"),
    ) as Record<string, unknown>;
    expect(provenance).toMatchObject({
      redistributed: false,
      archiveSha256: USRP_B205_FIRMWARE.archiveSha256,
      memberSha256: USRP_B205_FIRMWARE.memberSha256,
    });
    expect(existsSync(`public/assets/usrp-b205/uhd-4.9.0.0/${USRP_B205_FIRMWARE.memberFilename}`)).toBe(false);
  });

  it("parses bounded data and the pinned execution record", () => {
    expect(parseUsrpB205Firmware(fixture())).toEqual([
      { address: 0x40010100, bytes: Uint8Array.of(1, 2, 3, 4), execute: false },
      { address: 0x40019dec, bytes: new Uint8Array(), execute: true },
    ]);
  });

  it.each([
    fixture().replace(/.$/, "0"),
    `${fixture()}\n${record(0, 0, [1])}`,
    [record(0x05, 0, [0, 0, 0, 0]), record(1, 0, [])].join("\n"),
    [record(2, 0, [0, 0]), record(1, 0, [])].join("\n"),
  ])("rejects malformed or unpinned Intel HEX", (text) => {
    expect(() => parseUsrpB205Firmware(text)).toThrow();
  });

  it("requires the pinned filename, byte length and digest before parsing", async () => {
    const text = `${fixture()}\n${record(0, 0, [1])}`.padEnd(USRP_B205_FIRMWARE.memberByteLength, "\n");
    const digest = async () => USRP_B205_FIRMWARE.memberSha256;
    await expect(verifyUsrpB205FirmwareImport(USRP_B205_FIRMWARE.memberFilename, new TextEncoder().encode(text), digest))
      .rejects.toThrow(/records after Intel HEX EOF/);
    await expect(verifyUsrpB205FirmwareImport("other.hex", new Uint8Array(), digest)).rejects.toThrow(/no other FX3 firmware/);
  });
});

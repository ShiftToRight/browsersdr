import { describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import {
  transferUsrpB205NoOsSpi,
  validateUsrpB205NoOsModule,
} from "./usrpB205LocalNoOsDriver";
import type { UsrpB205Ad9364Spi } from "./usrpB205RxConfig";

function spiFixture(readValues: Record<number, number> = {}): UsrpB205Ad9364Spi {
  return {
    readRegister: vi.fn(async (address: number) => readValues[address] ?? 0),
    writeRegister: vi.fn(async () => undefined),
  };
}

describe("packaged B205 no-OS SPI bridge", () => {
  it("matches the reviewed generated artifact digests", () => {
    const digest = (url: URL) => createHash("sha256").update(readFileSync(url)).digest("hex");
    expect(digest(new URL("../vendor/adi-no-os/ad9364-no-os.js", import.meta.url)))
      .toBe("630273ef7c483e2c11dd31143e4d78bcf50a1f22e5e270860578331500cd7286");
    expect(digest(new URL("../vendor/adi-no-os/ad9364-no-os.wasm", import.meta.url)))
      .toBe("2eae629bf4f295c49b1d27fb8f0a4edf39e71e4083094cc937753250eb624598");
  });

  it("exports live WebAssembly memory views required by RF readback", () => {
    const generated = readFileSync(
      new URL("../vendor/adi-no-os/ad9364-no-os.js", import.meta.url),
      "utf8",
    );
    expect(generated).toContain(
      "Object.defineProperties(Module,{HEAPU8:{get:()=>HEAPU8},HEAPU32:{get:()=>HEAPU32}})",
    );
    expect(() => validateUsrpB205NoOsModule({})).toThrow(
      "does not expose its WebAssembly memory views",
    );
    expect(() => validateUsrpB205NoOsModule({
      HEAPU8: new Uint8Array(8),
      HEAPU32: new Uint32Array(2),
    })).not.toThrow();
  });

  it("maps a no-OS multi-byte write to descending AD9364 registers", async () => {
    const spi = spiFixture();
    const output = await transferUsrpB205NoOsSpi(
      spi,
      Uint8Array.of(0xb2, 0x34, 0xaa, 0xbb, 0xcc, 0xdd),
    );

    expect(spi.writeRegister).toHaveBeenCalledTimes(4);
    expect(spi.writeRegister).toHaveBeenNthCalledWith(1, 0x234, 0xaa);
    expect(spi.writeRegister).toHaveBeenNthCalledWith(4, 0x231, 0xdd);
    expect(output).toEqual(Uint8Array.of(0xb2, 0x34, 0xaa, 0xbb, 0xcc, 0xdd));
  });

  it("returns no-OS read bytes without changing the two command bytes", async () => {
    const spi = spiFixture({ 0x101: 0x12, 0x100: 0x34 });
    const output = await transferUsrpB205NoOsSpi(spi, Uint8Array.of(0x11, 0x01, 0, 0));

    expect(spi.readRegister).toHaveBeenNthCalledWith(1, 0x101);
    expect(spi.readRegister).toHaveBeenNthCalledWith(2, 0x100);
    expect(output).toEqual(Uint8Array.of(0x11, 0x01, 0x12, 0x34));
  });

  it("rejects malformed command lengths before touching hardware", async () => {
    const spi = spiFixture();

    await expect(
      transferUsrpB205NoOsSpi(spi, Uint8Array.of(0x20, 0x01, 0xaa)),
    ).rejects.toThrow("Unexpected no-OS SPI transfer length");
    expect(spi.readRegister).not.toHaveBeenCalled();
    expect(spi.writeRegister).not.toHaveBeenCalled();
  });
});

import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { BLADERF_HOSTED_IMAGES, selectBladeRfXa4Image } from "./bladerfImages";

describe("bundled bladeRF hosted image catalog", () => {
  it("selects only the pinned xA4 image compatible with the detected firmware", () => {
    expect(selectBladeRfXa4Image({ major: 2, minor: 4 })).toMatchObject({ model: "xA4", version: "0.15.3", byteLength: 2_632_660 });
    expect(selectBladeRfXa4Image({ major: 2, minor: 5 })).toMatchObject({ model: "xA4", version: "0.16.0", byteLength: 2_632_660 });
    expect(selectBladeRfXa4Image({ major: 2, minor: 6 })).toMatchObject({ model: "xA4", version: "0.16.0" });
    expect(() => selectBladeRfXa4Image({ major: 2, minor: 3 })).toThrow(/too old/i);
  });

  it("catalogs related Micro images without advertising them as supported receive profiles", () => {
    expect(BLADERF_HOSTED_IMAGES.filter((image) => image.receiveProfileSupported).every((image) => image.model === "xA4")).toBe(true);
    expect(BLADERF_HOSTED_IMAGES.filter((image) => !image.receiveProfileSupported).map((image) => image.model)).toEqual(["xA5", "xA9"]);
  });

  it("ships every catalogued image with the exact pinned length and SHA-256", async () => {
    for (const image of BLADERF_HOSTED_IMAGES) {
      const bytes = await readFile(resolve("public", image.publicPath));
      expect(bytes.byteLength, image.publicPath).toBe(image.byteLength);
      expect(createHash("sha256").update(bytes).digest("hex"), image.publicPath).toBe(image.sha256);
    }
  });
});

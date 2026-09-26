import { describe, expect, it } from "vitest";
import {
  BLADERF_HOSTED_IMAGES,
  selectBladeRfXa4Image,
  verifyBladeRfImage,
} from "./bladerfImages";

describe("user-imported bladeRF hosted image catalog", () => {
  it("selects only the pinned xA4 image compatible with the detected firmware", () => {
    expect(selectBladeRfXa4Image({ major: 2, minor: 4 })).toMatchObject({
      model: "xA4",
      version: "0.15.3",
      byteLength: 2_632_660,
    });
    expect(selectBladeRfXa4Image({ major: 2, minor: 5 })).toMatchObject({
      model: "xA4",
      version: "0.16.0",
      byteLength: 2_632_660,
    });
    expect(selectBladeRfXa4Image({ major: 2, minor: 6 })).toMatchObject({
      model: "xA4",
      version: "0.16.0",
    });
    expect(() => selectBladeRfXa4Image({ major: 2, minor: 3 })).toThrow(
      /too old/i,
    );
  });

  it("catalogs only supported xA4 images at immutable Nuand URLs", () => {
    expect(BLADERF_HOSTED_IMAGES).toHaveLength(2);
    expect(
      BLADERF_HOSTED_IMAGES.every(
        (image) => image.model === "xA4" && image.receiveProfileSupported,
      ),
    ).toBe(true);
    expect(
      BLADERF_HOSTED_IMAGES.every((image) =>
        image.upstreamUrl.includes(`/v${image.version}/hostedxA4.rbf`),
      ),
    ).toBe(true);
  });

  it("rejects imported images before storage when length or SHA-256 is wrong", async () => {
    const image = BLADERF_HOSTED_IMAGES[0]!;
    await expect(verifyBladeRfImage(image, new Uint8Array(16))).rejects.toThrow(
      /bytes/i,
    );
    await expect(
      verifyBladeRfImage(image, new Uint8Array(image.byteLength)),
    ).rejects.toThrow(/SHA-256/i);
  });
});

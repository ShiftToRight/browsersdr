import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import {
  BLADERF_HOSTED_IMAGES,
  selectBladeRfImage,
  selectBladeRfXa4Image,
  verifyBladeRfImage,
  importBladeRfImage,
  storedBladeRfImages,
  loadStoredBladeRfImage,
} from "./bladerfImages";
import { bladeRfModelLabel, bladeRfModelValidation } from "./bladerfModels";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

// Delay only completion; the digest itself is native SHA-256, never fabricated.
function pauseNativeDigest() {
  const native = crypto.subtle.digest.bind(crypto.subtle);
  let resume!: () => void;
  let reached!: () => void;
  const ready = new Promise<void>((resolve) => {
    reached = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    resume = resolve;
  });
  vi.spyOn(crypto.subtle, "digest").mockImplementation(
    async (algorithm, data) => {
      const result = await native(algorithm, data);
      reached();
      await gate;
      return result;
    },
  );
  return { ready, resume };
}

function cannotMutate(
  image: (typeof BLADERF_HOSTED_IMAGES)[number],
  hash: string,
) {
  expect(Object.isFrozen(image)).toBe(true);
  expect(Reflect.set(image, "sha256", hash)).toBe(false);
  expect(Reflect.set(image, "model", "xA9")).toBe(false);
}

// Minimal asynchronous storage port: browser IndexedDB behavior remains e2e-tested.
function installImageStorage() {
  const records = new Map<string, { sha256: string; bytes: ArrayBuffer }>();
  const database = {
    close() {},
    transaction() {
      const transaction = {
        oncomplete: undefined as (() => void) | undefined,
        objectStore: () => ({
          put(record: { sha256: string; bytes: ArrayBuffer }) {
            records.set(record.sha256, structuredClone(record));
            queueMicrotask(() => transaction.oncomplete?.());
          },
          get(hash: string) {
            const request = {
              result: structuredClone(records.get(hash)),
              onsuccess: undefined as (() => void) | undefined,
            };
            queueMicrotask(() => request.onsuccess?.());
            return request;
          },
        }),
      };
      return transaction;
    },
  };
  vi.stubGlobal("indexedDB", {
    open() {
      const request = {
        result: database,
        onsuccess: undefined as (() => void) | undefined,
      };
      queueMicrotask(() => request.onsuccess?.());
      return request;
    },
  });
  return records;
}

describe("user-imported bladeRF hosted image catalog", () => {
  it("selects each model's 0.15.3 image on firmware 2.4", () => {
    for (const model of ["xA4", "xA5", "xA9"] as const) {
      expect(selectBladeRfImage(model, { major: 2, minor: 4 })).toMatchObject({
        model,
        version: "0.15.3",
      });
    }
  });

  it("selects each model's 0.16.0 image on firmware 2.5 and newer major-2 firmware", () => {
    for (const model of ["xA4", "xA5", "xA9"] as const) {
      expect(selectBladeRfImage(model, { major: 2, minor: 5 })).toMatchObject({
        model,
        version: "0.16.0",
      });
      expect(selectBladeRfImage(model, { major: 2, minor: 6 })).toMatchObject({
        model,
        version: "0.16.0",
      });
      expect(selectBladeRfImage(model, { major: 2, minor: 65 })).toMatchObject({
        model,
        version: "0.16.0",
      });
    }
  });

  it("rejects unsupported firmware, malformed versions, and unknown models", () => {
    for (const firmware of [
      { major: 2, minor: 3 },
      { major: 3, minor: 6 },
      { major: 2, minor: 6.5 },
      { major: 2, minor: -1 },
      { major: 65_536, minor: 6 },
      { major: Number.NaN, minor: 6 },
    ]) {
      expect(() => selectBladeRfImage("xA4", firmware)).toThrow(/firmware/i);
    }
    expect(() =>
      selectBladeRfImage("xA6" as "xA4", { major: 2, minor: 4 }),
    ).toThrow(/model|unsupported/i);
  });

  it("keeps the legacy selector explicitly xA4 and labels experimental variants", () => {
    expect(selectBladeRfXa4Image({ major: 2, minor: 4 })).toBe(
      selectBladeRfImage("xA4", { major: 2, minor: 4 }),
    );
    expect(bladeRfModelLabel("xA9")).toBe("bladeRF 2.0 Micro xA9");
    expect(bladeRfModelValidation("xA4")).toBe("existing-xa4-profile");
    expect(bladeRfModelValidation("xA5")).toBe("experimental");
    expect(selectBladeRfXa4Image({ major: 2, minor: 5 })).toMatchObject({
      model: "xA4",
      version: "0.16.0",
    });
    expect(() => bladeRfModelLabel("unknown" as "xA4")).toThrow(/model/i);
  });

  it("catalogs only the six source-established official hosted images", () => {
    expect(BLADERF_HOSTED_IMAGES).toHaveLength(6);
    for (const model of ["xA4", "xA5", "xA9"] as const) {
      for (const version of ["0.15.3", "0.16.0"] as const) {
        const image = BLADERF_HOSTED_IMAGES.find(
          (candidate) =>
            candidate.model === model && candidate.version === version,
        );
        expect(image).toBeDefined();
        expect(image?.upstreamUrl).toBe(
          `https://www.nuand.com/fpga/v${version}/hosted${model}.rbf`,
        );
        expect(image?.receiveProfileSupported).toBe(true);
      }
    }
  });

  it("rejects wrong lengths and same-length corrupt bytes with real SHA-256", async () => {
    const image = selectBladeRfImage("xA9", { major: 2, minor: 6 });
    await expect(verifyBladeRfImage(image, new Uint8Array(16))).rejects.toThrow(
      /bytes/i,
    );
    await expect(
      verifyBladeRfImage(image, new Uint8Array(image.byteLength)),
    ).rejects.toThrow(/SHA-256/i);
  });

  it("freezes public entries and array against same-length native-SHA catalog forgery", async () => {
    const image = selectBladeRfXa4Image({ major: 2, minor: 6 });
    const bytes = new Uint8Array(image.byteLength);
    const hash = Buffer.from(
      await crypto.subtle.digest("SHA-256", bytes),
    ).toString("hex");
    cannotMutate(image, hash);
    for (const entry of BLADERF_HOSTED_IMAGES) cannotMutate(entry, hash);
    expect(Object.isFrozen(BLADERF_HOSTED_IMAGES)).toBe(true);
    expect(
      Reflect.set(BLADERF_HOSTED_IMAGES, "0", { ...image, sha256: hash }),
    ).toBe(false);
    expect(() =>
      (BLADERF_HOSTED_IMAGES as unknown as unknown[]).push(image),
    ).toThrow();
    await expect(verifyBladeRfImage(image, bytes)).rejects.toThrow(/SHA-256/);
  });

  it.each(["verify", "import"] as const)(
    "rejects corrupt bytes when catalog mutation is attempted during native %s digest",
    async (operation) => {
      const image = selectBladeRfXa4Image({ major: 2, minor: 6 });
      const descriptor = { ...image };
      const bytes = new Uint8Array(image.byteLength);
      const hash = Buffer.from(
        await crypto.subtle.digest("SHA-256", bytes),
      ).toString("hex");
      const pause = pauseNativeDigest();
      const pending =
        operation === "verify"
          ? verifyBladeRfImage(descriptor, bytes)
          : importBladeRfImage(new Blob([bytes]));
      const rejected = expect(pending).rejects.toThrow(/SHA-256/);
      await pause.ready;
      cannotMutate(image, hash);
      cannotMutate(
        BLADERF_HOSTED_IMAGES.find((entry) => entry.sha256 === image.sha256)!,
        hash,
      );
      descriptor.sha256 = hash;
      pause.resume();
      await rejected;
    },
  );

  it.skipIf(!process.env.BLADERF_OFFICIAL_ARTIFACT_DIR)(
    "retains official attribution through digest waits, import/list views, and stored revalidation with native SHA",
    async () => {
      const records = installImageStorage();
      const image = selectBladeRfXa4Image({ major: 2, minor: 6 });
      const bytes = Uint8Array.from(
        readFileSync(
          `${process.env.BLADERF_OFFICIAL_ARTIFACT_DIR}/${image.filename}`,
        ),
      );
      const descriptor = { ...image };
      const pause = pauseNativeDigest();
      const verification = verifyBladeRfImage(descriptor, bytes);
      const importing = importBladeRfImage(new Blob([bytes]));
      await pause.ready;
      descriptor.sha256 = "0".repeat(64);
      cannotMutate(image, descriptor.sha256);
      pause.resume();
      expect(Buffer.from(await verification).equals(Buffer.from(bytes))).toBe(
        true,
      );
      const imported = await importing;
      cannotMutate(imported, descriptor.sha256);
      const listed = await storedBladeRfImages();
      expect(listed).toEqual([image]);
      cannotMutate(listed[0]!, descriptor.sha256);
      listed.splice(0); // Array consumers may edit their list, never the trust root.
      expect(
        Buffer.from(await loadStoredBladeRfImage(imported)).equals(
          Buffer.from(bytes),
        ),
      ).toBe(true);
      const storedBytes = new Uint8Array(records.get(image.sha256)!.bytes);
      storedBytes[0] = storedBytes[0]! ^ 1;
      await expect(loadStoredBladeRfImage(imported)).rejects.toThrow(
        /failed verification/,
      );
      expect(selectBladeRfXa4Image({ major: 2, minor: 6 }).sha256).toBe(
        image.sha256,
      );
    },
  );

  it("rejects descriptors forged for a different model or release", async () => {
    const image = selectBladeRfImage("xA4", { major: 2, minor: 4 });
    const bytes = new Uint8Array(1);
    await expect(
      verifyBladeRfImage({ ...image, model: "xA5" }, bytes),
    ).rejects.toThrow(/catalog/i);
    await expect(
      verifyBladeRfImage({ ...image, version: "0.16.0" }, bytes),
    ).rejects.toThrow(/catalog/i);
  });
});

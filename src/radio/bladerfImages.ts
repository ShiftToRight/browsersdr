import {
  assertBladeRfMicroModel,
  type BladeRfFirmwareVersion,
  type BladeRfMicroModel,
} from "./bladerfModels";

export type { BladeRfMicroModel } from "./bladerfModels";

export interface BladeRfHostedImage {
  readonly model: BladeRfMicroModel;
  readonly version: "0.15.3" | "0.16.0";
  readonly byteLength: number;
  readonly sha256: string;
  readonly filename: string;
  readonly upstreamUrl: string;
  readonly receiveProfileSupported: true;
}

interface StoredBladeRfImage {
  sha256: string;
  bytes: ArrayBuffer;
  storedAt: number;
}

const DATABASE_NAME = "browsersdr-bladerf-images";
const DATABASE_VERSION = 1;
const IMAGE_STORE = "verified-images";

/** Official hosted images; users download and import them from Nuand. */
const TRUSTED_HOSTED_IMAGES: readonly BladeRfHostedImage[] = Object.freeze(
  [
    {
      model: "xA4",
      version: "0.15.3",
      byteLength: 2_632_660,
      sha256:
        "eaa415650b6b00e75f1e28c2a860d8f90577b1f4648b2f7b88a65745f464a6db",
      filename: "hostedxA4-v0.15.3.rbf",
      upstreamUrl: "https://www.nuand.com/fpga/v0.15.3/hostedxA4.rbf",
      receiveProfileSupported: true,
    },
    {
      model: "xA5",
      version: "0.15.3",
      byteLength: 4_244_820,
      sha256:
        "d02d07778dfec9b02447aec174c830a5d178448807bdd56830e7da7fceacf5aa",
      filename: "hostedxA5-v0.15.3.rbf",
      upstreamUrl: "https://www.nuand.com/fpga/v0.15.3/hostedxA5.rbf",
      receiveProfileSupported: true,
    },
    {
      model: "xA9",
      version: "0.15.3",
      byteLength: 12_858_972,
      sha256:
        "3222349aea26a304a0ecd31858cb3ae032f39ec49b81b2ee9c8a4c9ea1b8f4e7",
      filename: "hostedxA9-v0.15.3.rbf",
      upstreamUrl: "https://www.nuand.com/fpga/v0.15.3/hostedxA9.rbf",
      receiveProfileSupported: true,
    },
    {
      model: "xA4",
      version: "0.16.0",
      byteLength: 2_632_660,
      sha256:
        "c0d1ed6a38900629ec7983ddd27b2d438ca7a7d2b897d37364ff0c2511210ace",
      filename: "hostedxA4-v0.16.0.rbf",
      upstreamUrl: "https://www.nuand.com/fpga/v0.16.0/hostedxA4.rbf",
      receiveProfileSupported: true,
    },
    {
      model: "xA5",
      version: "0.16.0",
      byteLength: 4_244_820,
      sha256:
        "b85b413c0b305a04bd3fdb604ff6c77a1eac427f07d72251920a60b6a2f5b062",
      filename: "hostedxA5-v0.16.0.rbf",
      upstreamUrl: "https://www.nuand.com/fpga/v0.16.0/hostedxA5.rbf",
      receiveProfileSupported: true,
    },
    {
      model: "xA9",
      version: "0.16.0",
      byteLength: 12_858_972,
      sha256:
        "3004467110e2b2790c8f6128f998c2149905a88eed91a87f11af3db524d60c65",
      filename: "hostedxA9-v0.16.0.rbf",
      upstreamUrl: "https://www.nuand.com/fpga/v0.16.0/hostedxA9.rbf",
      receiveProfileSupported: true,
    },
  ].map((image) => Object.freeze(image)) as BladeRfHostedImage[],
);

/** Runtime-immutable public views cannot redefine the private trust root. */
export const BLADERF_HOSTED_IMAGES: readonly BladeRfHostedImage[] =
  Object.freeze(
    TRUSTED_HOSTED_IMAGES.map((image) => Object.freeze({ ...image })),
  );

function validateFirmware(firmware: BladeRfFirmwareVersion): void {
  if (
    !firmware ||
    !Number.isInteger(firmware.major) ||
    !Number.isInteger(firmware.minor) ||
    firmware.major < 0 ||
    firmware.major > 0xffff ||
    firmware.minor < 0 ||
    firmware.minor > 0xffff
  )
    throw new Error(
      "bladeRF firmware version must contain uint16 integer major and minor values.",
    );
}

export function selectBladeRfImage(
  model: BladeRfMicroModel,
  firmware: BladeRfFirmwareVersion,
): BladeRfHostedImage {
  assertBladeRfMicroModel(model);
  validateFirmware(firmware);
  if (firmware.major !== 2 || firmware.minor < 4)
    throw new Error(
      `bladeRF firmware ${firmware.major}.${firmware.minor} is unsupported for the volatile ${model} profiles. Firmware 2.4 requires FPGA 0.15.3; firmware 2.5 or newer requires FPGA 0.16.0.`,
    );
  const version = firmware.minor === 4 ? "0.15.3" : "0.16.0";
  const image = TRUSTED_HOSTED_IMAGES.find(
    (candidate) => candidate.model === model && candidate.version === version,
  );
  if (!image)
    throw new Error(
      `No hosted ${model} FPGA image is cataloged for ${version}.`,
    );
  return image;
}

/** Kept for existing xA4 callers. */
export function selectBladeRfXa4Image(
  firmware: BladeRfFirmwareVersion,
): BladeRfHostedImage {
  return selectBladeRfImage("xA4", firmware);
}

function hex(bytes: Uint8Array): string {
  return [...bytes]
    .map((value) => value.toString(16).padStart(2, "0"))
    .join("");
}

async function digest(bytes: Uint8Array): Promise<string> {
  return hex(
    new Uint8Array(
      await crypto.subtle.digest("SHA-256", bytes.buffer as ArrayBuffer),
    ),
  );
}

function canonicalImage(image: BladeRfHostedImage): BladeRfHostedImage {
  if (!image || typeof image !== "object")
    throw new Error("The selected bladeRF FPGA image descriptor is invalid.");
  assertBladeRfMicroModel((image as BladeRfHostedImage).model);
  const canonical = TRUSTED_HOSTED_IMAGES.find(
    (candidate) => candidate.sha256 === image.sha256,
  );
  if (
    !canonical ||
    canonical.model !== image.model ||
    canonical.version !== image.version ||
    canonical.byteLength !== image.byteLength ||
    canonical.filename !== image.filename ||
    canonical.upstreamUrl !== image.upstreamUrl ||
    canonical.receiveProfileSupported !== image.receiveProfileSupported
  )
    throw new Error(
      "The selected bladeRF FPGA image descriptor is not in the official catalog.",
    );
  return canonical;
}

function ownedBytes(input: ArrayBuffer | Uint8Array): Uint8Array {
  return input instanceof Uint8Array
    ? Uint8Array.from(input)
    : Uint8Array.from(new Uint8Array(input));
}

export async function verifyBladeRfImage(
  image: BladeRfHostedImage,
  input: ArrayBuffer | Uint8Array,
): Promise<Uint8Array> {
  const canonical = canonicalImage(image);
  const bytes = ownedBytes(input);
  if (bytes.byteLength !== canonical.byteLength)
    throw new Error(
      `The selected ${canonical.model} file has ${bytes.byteLength.toLocaleString()} bytes; hosted${canonical.model} ${canonical.version} requires ${canonical.byteLength.toLocaleString()} bytes.`,
    );
  if ((await digest(bytes)) !== canonical.sha256)
    throw new Error(
      `The selected file is not the official hosted${canonical.model} ${canonical.version} image (SHA-256 mismatch).`,
    );
  return bytes;
}

async function identifyBladeRfImage(
  input: ArrayBuffer,
): Promise<{ image: BladeRfHostedImage; bytes: Uint8Array }> {
  const bytes = ownedBytes(input);
  const candidates = TRUSTED_HOSTED_IMAGES.filter(
    (image) => image.byteLength === bytes.byteLength,
  );
  if (!candidates.length)
    throw new Error(
      `The selected file has ${bytes.byteLength.toLocaleString()} bytes and is not a supported hosted bladeRF FPGA image.`,
    );
  const sha256 = await digest(bytes);
  const image = candidates.find((candidate) => candidate.sha256 === sha256);
  if (!image)
    throw new Error(
      "The selected file does not match an official supported hosted bladeRF image (SHA-256 mismatch).",
    );
  return { image, bytes };
}

function openDatabase(): Promise<IDBDatabase> {
  if (typeof indexedDB === "undefined")
    return Promise.reject(
      new Error("This browser does not provide local FPGA image storage."),
    );
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(IMAGE_STORE))
        request.result.createObjectStore(IMAGE_STORE, { keyPath: "sha256" });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () =>
      reject(request.error ?? new Error("Could not open FPGA image storage."));
    request.onblocked = () =>
      reject(new Error("FPGA image storage is blocked by another page."));
  });
}

async function readStoredImage(
  image: BladeRfHostedImage,
): Promise<StoredBladeRfImage | undefined> {
  const canonical = canonicalImage(image);
  const database = await openDatabase();
  try {
    return await new Promise((resolve, reject) => {
      const request = database
        .transaction(IMAGE_STORE, "readonly")
        .objectStore(IMAGE_STORE)
        .get(canonical.sha256);
      request.onsuccess = () =>
        resolve(request.result as StoredBladeRfImage | undefined);
      request.onerror = () =>
        reject(request.error ?? new Error("Could not read the FPGA image."));
    });
  } finally {
    database.close();
  }
}

export async function storedBladeRfImages(): Promise<BladeRfHostedImage[]> {
  const present = await Promise.all(
    TRUSTED_HOSTED_IMAGES.map(async (image) => ({
      image,
      stored: Boolean(await readStoredImage(image)),
    })),
  );
  return present.filter(({ stored }) => stored).map(({ image }) => image);
}

/** Legacy xA4-only adapter for existing UI callers. */
export async function storedBladeRfImageVersions(): Promise<string[]> {
  const images = await storedBladeRfImages();
  return images
    .filter((image) => image.model === "xA4")
    .map((image) => image.version);
}

export async function importBladeRfImage(
  file: Blob,
): Promise<BladeRfHostedImage> {
  const { image, bytes } = await identifyBladeRfImage(await file.arrayBuffer());
  const database = await openDatabase();
  try {
    await new Promise<void>((resolve, reject) => {
      const transaction = database.transaction(IMAGE_STORE, "readwrite");
      transaction.objectStore(IMAGE_STORE).put({
        sha256: image.sha256,
        bytes: Uint8Array.from(bytes).buffer,
        storedAt: Date.now(),
      } satisfies StoredBladeRfImage);
      transaction.oncomplete = () => resolve();
      transaction.onerror = () =>
        reject(
          transaction.error ?? new Error("Could not save the FPGA image."),
        );
      transaction.onabort = () =>
        reject(
          transaction.error ?? new Error("Saving the FPGA image was aborted."),
        );
    });
  } finally {
    database.close();
  }
  try {
    await navigator.storage?.persist?.();
  } catch {
    // Persistence is optional; the verified IndexedDB copy remains usable.
  }
  return image;
}

export async function loadStoredBladeRfImage(
  image: BladeRfHostedImage,
): Promise<Uint8Array> {
  const canonical = canonicalImage(image);
  const stored = await readStoredImage(canonical);
  if (!stored)
    throw new Error(
      `bladeRF needs hosted${canonical.model} ${canonical.version}. Download it from Nuand, import the .rbf in Advanced source settings, then reconnect. The device was not modified.`,
    );
  try {
    return await verifyBladeRfImage(canonical, stored.bytes);
  } catch {
    throw new Error(
      `The saved hosted${canonical.model} ${canonical.version} image failed verification. Import a fresh copy from Nuand, then reconnect. The device was not modified.`,
    );
  }
}

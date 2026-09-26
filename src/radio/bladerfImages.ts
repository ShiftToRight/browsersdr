export type BladeRfMicroModel = "xA4";

export interface BladeRfHostedImage {
  model: BladeRfMicroModel;
  version: "0.15.3" | "0.16.0";
  byteLength: number;
  sha256: string;
  filename: string;
  upstreamUrl: string;
  receiveProfileSupported: true;
}

interface StoredBladeRfImage {
  sha256: string;
  bytes: ArrayBuffer;
  storedAt: number;
}

const DATABASE_NAME = "browsersdr-bladerf-images";
const DATABASE_VERSION = 1;
const IMAGE_STORE = "verified-images";

/**
 * Official Nuand hosted images supported by the receive-only xA4 profile.
 * BrowserSDR does not redistribute these files: the user downloads them from
 * Nuand, imports them once, and the verified bytes remain in browser storage.
 */
export const BLADERF_HOSTED_IMAGES: readonly BladeRfHostedImage[] = [
  {
    model: "xA4",
    version: "0.15.3",
    byteLength: 2_632_660,
    sha256: "eaa415650b6b00e75f1e28c2a860d8f90577b1f4648b2f7b88a65745f464a6db",
    filename: "hostedxA4-v0.15.3.rbf",
    upstreamUrl: "https://www.nuand.com/fpga/v0.15.3/hostedxA4.rbf",
    receiveProfileSupported: true,
  },
  {
    model: "xA4",
    version: "0.16.0",
    byteLength: 2_632_660,
    sha256: "c0d1ed6a38900629ec7983ddd27b2d438ca7a7d2b897d37364ff0c2511210ace",
    filename: "hostedxA4-v0.16.0.rbf",
    upstreamUrl: "https://www.nuand.com/fpga/v0.16.0/hostedxA4.rbf",
    receiveProfileSupported: true,
  },
] as const;

export function selectBladeRfXa4Image(firmware: {
  major: number;
  minor: number;
}): BladeRfHostedImage {
  if (firmware.major !== 2 || firmware.minor < 4)
    throw new Error(
      `bladeRF firmware ${firmware.major}.${firmware.minor} is too old for the volatile xA4 profiles.`,
    );
  const version = firmware.minor >= 5 ? "0.16.0" : "0.15.3";
  return BLADERF_HOSTED_IMAGES.find((image) => image.version === version)!;
}

function hex(bytes: Uint8Array): string {
  return [...bytes]
    .map((value) => value.toString(16).padStart(2, "0"))
    .join("");
}

async function digest(bytes: Uint8Array): Promise<string> {
  const owned = Uint8Array.from(bytes);
  return hex(
    new Uint8Array(await crypto.subtle.digest("SHA-256", owned.buffer)),
  );
}

export async function verifyBladeRfImage(
  image: BladeRfHostedImage,
  input: ArrayBuffer | Uint8Array,
): Promise<Uint8Array> {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  if (bytes.byteLength !== image.byteLength)
    throw new Error(
      `The selected file has ${bytes.byteLength.toLocaleString()} bytes; hostedxA4 ${image.version} requires ${image.byteLength.toLocaleString()} bytes.`,
    );
  if ((await digest(bytes)) !== image.sha256)
    throw new Error(
      `The selected file is not the official hostedxA4 ${image.version} image (SHA-256 mismatch).`,
    );
  return bytes;
}

async function identifyBladeRfImage(
  input: ArrayBuffer,
): Promise<{ image: BladeRfHostedImage; bytes: Uint8Array }> {
  const bytes = new Uint8Array(input);
  const candidates = BLADERF_HOSTED_IMAGES.filter(
    (image) => image.byteLength === bytes.byteLength,
  );
  if (!candidates.length)
    throw new Error(
      `The selected file has ${bytes.byteLength.toLocaleString()} bytes and is not a supported hostedxA4 image.`,
    );
  const sha256 = await digest(bytes);
  const image = candidates.find((candidate) => candidate.sha256 === sha256);
  if (!image)
    throw new Error(
      "The selected file does not match an official supported hostedxA4 image (SHA-256 mismatch).",
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
  const database = await openDatabase();
  try {
    return await new Promise((resolve, reject) => {
      const request = database
        .transaction(IMAGE_STORE, "readonly")
        .objectStore(IMAGE_STORE)
        .get(image.sha256);
      request.onsuccess = () =>
        resolve(request.result as StoredBladeRfImage | undefined);
      request.onerror = () =>
        reject(request.error ?? new Error("Could not read the FPGA image."));
    });
  } finally {
    database.close();
  }
}

export async function storedBladeRfImageVersions(): Promise<string[]> {
  const present = await Promise.all(
    BLADERF_HOSTED_IMAGES.map(async (image) => ({
      image,
      stored: Boolean(await readStoredImage(image)),
    })),
  );
  return present
    .filter(({ stored }) => stored)
    .map(({ image }) => image.version);
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
  const stored = await readStoredImage(image);
  if (!stored)
    throw new Error(
      `bladeRF needs hostedxA4 ${image.version}. Download it from Nuand, import the .rbf in Advanced source settings, then reconnect. The device was not modified.`,
    );
  try {
    return await verifyBladeRfImage(image, stored.bytes);
  } catch {
    throw new Error(
      `The saved hostedxA4 ${image.version} image failed verification. Import a fresh copy from Nuand, then reconnect. The device was not modified.`,
    );
  }
}

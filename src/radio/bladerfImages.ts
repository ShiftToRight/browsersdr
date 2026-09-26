export type BladeRfMicroModel = "xA4" | "xA5" | "xA9";

export interface BladeRfHostedImage {
  model: BladeRfMicroModel;
  version: "0.15.3" | "0.16.0";
  byteLength: number;
  sha256: string;
  publicPath: string;
  upstreamUrl: string;
  receiveProfileSupported: boolean;
}

/**
 * Official Nuand hosted images shipped as lazy static assets. Only xA4 is
 * currently selectable: an unconfigured Micro does not expose enough of the
 * FPGA identity through the WebUSB descriptor to guess A4/A5/A9 safely.
 */
export const BLADERF_HOSTED_IMAGES: readonly BladeRfHostedImage[] = [
  {
    model: "xA4",
    version: "0.15.3",
    byteLength: 2_632_660,
    sha256: "eaa415650b6b00e75f1e28c2a860d8f90577b1f4648b2f7b88a65745f464a6db",
    publicPath: "vendor/nuand/fpga/v0.15.3/hostedxA4.rbf",
    upstreamUrl: "https://www.nuand.com/fpga/v0.15.3/hostedxA4.rbf",
    receiveProfileSupported: true,
  },
  {
    model: "xA4",
    version: "0.16.0",
    byteLength: 2_632_660,
    sha256: "c0d1ed6a38900629ec7983ddd27b2d438ca7a7d2b897d37364ff0c2511210ace",
    publicPath: "vendor/nuand/fpga/v0.16.0/hostedxA4.rbf",
    upstreamUrl: "https://www.nuand.com/fpga/v0.16.0/hostedxA4.rbf",
    receiveProfileSupported: true,
  },
  {
    model: "xA5",
    version: "0.16.0",
    byteLength: 4_244_820,
    sha256: "b85b413c0b305a04bd3fdb604ff6c77a1eac427f07d72251920a60b6a2f5b062",
    publicPath: "vendor/nuand/fpga/v0.16.0/hostedxA5.rbf",
    upstreamUrl: "https://www.nuand.com/fpga/v0.16.0/hostedxA5.rbf",
    receiveProfileSupported: false,
  },
  {
    model: "xA9",
    version: "0.16.0",
    byteLength: 12_858_972,
    sha256: "3004467110e2b2790c8f6128f998c2149905a88eed91a87f11af3db524d60c65",
    publicPath: "vendor/nuand/fpga/v0.16.0/hostedxA9.rbf",
    upstreamUrl: "https://www.nuand.com/fpga/v0.16.0/hostedxA9.rbf",
    receiveProfileSupported: false,
  },
] as const;

export function selectBladeRfXa4Image(firmware: { major: number; minor: number }): BladeRfHostedImage {
  if (firmware.major !== 2 || firmware.minor < 4) throw new Error(`bladeRF firmware ${firmware.major}.${firmware.minor} is too old for the bundled volatile xA4 profiles.`);
  const version = firmware.minor >= 5 ? "0.16.0" : "0.15.3";
  return BLADERF_HOSTED_IMAGES.find((image) => image.model === "xA4" && image.version === version)!;
}

function hex(bytes: Uint8Array): string {
  return [...bytes].map((value) => value.toString(16).padStart(2, "0")).join("");
}

export async function loadBundledBladeRfImage(image: BladeRfHostedImage): Promise<Uint8Array> {
  const base = typeof document === "undefined" ? undefined : document.baseURI;
  if (!base) throw new Error("The bundled bladeRF FPGA image is available only in the browser application.");
  const response = await fetch(new URL(image.publicPath, base));
  if (!response.ok) throw new Error(`Could not load the bundled ${image.model} FPGA image (${response.status}).`);
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength !== image.byteLength) throw new Error(`Bundled ${image.model} FPGA image has ${bytes.byteLength} bytes; expected ${image.byteLength}. The device was not modified.`);
  const digest = hex(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)));
  if (digest !== image.sha256) throw new Error(`Bundled ${image.model} FPGA image failed SHA-256 verification. The device was not modified.`);
  return bytes;
}

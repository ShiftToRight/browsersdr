import { R820T } from "@jtarrio/webrtlsdr/rtlsdr/r820t.js";
import { R828D } from "@jtarrio/webrtlsdr/rtlsdr/r828d.js";

/** Pinned WebRTLSDR 3.0.6 stores its probed tuner instance on RTL2832U.
 * No public getter exists. Guard this narrow adapter; never use USB names or
 * constructor names to infer a board, R820T2 revision, or other unknown chip. */
export function rtlTunerIdentity(
  device: unknown,
): "R820T-family" | "R828D" | undefined {
  try {
    const tuner = (device as { tuner?: unknown })?.tuner;
    if (tuner instanceof R828D) return "R828D";
    if (tuner instanceof R820T) return "R820T-family";
  } catch {
    /* Future driver implementations may hide their internals. */
  }
  return undefined;
}

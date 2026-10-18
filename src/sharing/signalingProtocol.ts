export const SHARE_SCHEMA = "browsersdr-peer-prototype-v1";
export const MAX_SIGNAL_LENGTH = 65_536;
export interface SignalDescription {
  schema: typeof SHARE_SCHEMA;
  id: string;
  description: RTCSessionDescriptionInit;
}
export const validPeerId = (id: unknown): id is string => typeof id === "string" && /^[a-f0-9]{32}$/.test(id);
export function newPeerId(): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(16)), byte => byte.toString(16).padStart(2, "0")).join("");
}
export function parseSignal(text: string, type: "offer" | "answer"): SignalDescription {
  if (text.length > MAX_SIGNAL_LENGTH) throw new Error("Connection text is too large.");
  let value: SignalDescription;
  try { value = JSON.parse(text); } catch { throw new Error("Paste the complete connection text."); }
  if (!value || value.schema !== SHARE_SCHEMA || !validPeerId(value.id) || value.description?.type !== type ||
    typeof value.description.sdp !== "string" || value.description.sdp.length < 20 || !value.description.sdp.startsWith("v=0\r\n")) {
    throw new Error(`Expected a BrowserSDR ${type}.`);
  }
  return { schema: SHARE_SCHEMA, id: value.id, description: { type, sdp: value.description.sdp } };
}

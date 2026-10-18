export const SHARE_SCHEMA = "browsersdr-peer-prototype-v1";
export interface SignalDescription { schema: typeof SHARE_SCHEMA; id: string; description: RTCSessionDescriptionInit; }
export const MAX_SIGNAL_LENGTH = 65_536;
export const ROOM_PATH = "/api/v1/sharing";
export const validPeerId = (id: unknown): id is string => typeof id === "string" && /^[a-f0-9]{32}$/.test(id);
export function parseSignal(text: string, type: "offer" | "answer"): SignalDescription {
  if (typeof text !== "string" || text.length > MAX_SIGNAL_LENGTH) throw new Error("Connection text is too large.");
  let value: SignalDescription;
  try { value = JSON.parse(text) as SignalDescription; } catch { throw new Error("Paste the complete connection text."); }
  if (!value || value.schema !== SHARE_SCHEMA || !validPeerId(value.id) || value.description?.type !== type ||
    typeof value.description.sdp !== "string" || value.description.sdp.length < 20 || !value.description.sdp.startsWith("v=0\r\n")) throw new Error(`Expected a BrowserSDR ${type}.`);
  return { schema: SHARE_SCHEMA, id: value.id, description: { type, sdp: value.description.sdp } };
}
export function newPeerId(): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(16)), byte => byte.toString(16).padStart(2, "0")).join("");
}
export function parseCandidate(value: unknown): RTCIceCandidateInit | null {
  if (value === null) return null;
  if (!value || typeof value !== "object") throw new Error("Invalid ICE candidate.");
  const v = value as Record<string, unknown>;
  if (typeof v.candidate !== "string" || v.candidate.length > 4096 ||
    !(v.sdpMid === null || typeof v.sdpMid === "string" && v.sdpMid.length <= 256) ||
    !(v.sdpMLineIndex === null || typeof v.sdpMLineIndex === "number" && Number.isInteger(v.sdpMLineIndex) && v.sdpMLineIndex >= 0 && v.sdpMLineIndex < 64) ||
    !(v.usernameFragment === undefined || v.usernameFragment === null || typeof v.usernameFragment === "string" && v.usernameFragment.length <= 256)) throw new Error("Invalid ICE candidate.");
  return { candidate: v.candidate, sdpMid: v.sdpMid, sdpMLineIndex: v.sdpMLineIndex,
    ...(typeof v.usernameFragment === "string" ? { usernameFragment: v.usernameFragment } : {}) };
}
export function validateIceServers(value: unknown, requireRelay = true): RTCIceServer[] {
  if (!Array.isArray(value) || value.length > 8) throw new Error("Invalid ICE server configuration.");
  let udp = false, tls = false;
  const result: RTCIceServer[] = value.map((raw: unknown) => {
    if (!raw || typeof raw !== "object") throw new Error("Invalid ICE server.");
    const server = raw as Record<string, unknown>;
    const urls: unknown = typeof server.urls === "string" ? [server.urls] : server.urls;
    if (!Array.isArray(urls) || !urls.length || urls.length > 12) throw new Error("Invalid ICE URLs.");
    for (const url of urls as unknown[]) {
      if (typeof url !== "string" || url.length > 512 || !/^(stun|turn|turns):(?:[a-z0-9.-]+|\[[a-f0-9:]+\]):\d{1,5}(?:\?transport=(?:udp|tcp))?$/i.test(url)) throw new Error("Invalid ICE URL.");
      if (/^turn:.*\?transport=udp$/i.test(url)) udp = true;
      if (/^turns:.*\?transport=tcp$/i.test(url)) tls = true;
      if (/^turns?:/i.test(url) && (typeof server.username !== "string" || !server.username || server.username.length > 512 || typeof server.credential !== "string" || !server.credential || server.credential.length > 512)) throw new Error("TURN credentials are required.");
    }
    return { urls: urls as string[], ...(typeof server.username === "string" ? { username: server.username, credential: server.credential as string } : {}) };
  });
  if (requireRelay && (!udp || !tls)) throw new Error("Configure TURN/UDP and TURN/TLS.");
  return result;
}

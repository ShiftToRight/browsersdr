import { ROOM_PATH, validateIceServers, parseCandidate } from "./signalingProtocol";
export const normalizeJoinKey = (value: string): string => value.toUpperCase().replace(/[\s-]/g, "");
export const validJoinKey = (value: string): boolean => /^[2-9A-HJ-NP-Z]{12}$/.test(normalizeJoinKey(value));
export const formatJoinKey = (value: string): string => normalizeJoinKey(value).match(/.{1,4}/g)?.join("-") ?? "";
export interface RoomEvent { sequence: number; kind: "offer" | "answer" | "candidate"; value: string | RTCIceCandidateInit | null; }
export interface RoomAccess {
  token: string; expires: number; iceServers: RTCIceServer[]; iceTransportPolicy: RTCIceTransportPolicy; mode: "local" | "internet";
}
export class RoomError extends Error {
  constructor(message: string, readonly terminal: boolean, readonly status = 0) { super(message); }
}
async function request(body: object, signal?: AbortSignal, poll = false): Promise<Record<string, unknown>> {
  const response = await fetch(ROOM_PATH, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
    credentials: "omit", cache: "no-store", signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(poll ? 30_000 : 10_000)]) : AbortSignal.timeout(10_000) });
  if (response.status === 204) return {};
  let value: Record<string, unknown>;
  try { value = await response.json() as Record<string, unknown>; }
  catch { throw new RoomError("Session sharing is unavailable on this server. Please try again later.", true); }
  if (!response.ok) throw new RoomError(typeof value.error === "string" ? value.error : "Session exchange failed.", response.status >= 400 && response.status < 500, response.status);
  return value;
}
function access(value: Record<string, unknown>): RoomAccess {
  if (typeof value.token !== "string" || !/^[a-f0-9]{48}$/.test(value.token) || typeof value.expires !== "number" || !Number.isSafeInteger(value.expires) ||
    !["local", "internet"].includes(String(value.mode)) || !["all", "relay"].includes(String(value.iceTransportPolicy))) throw new RoomError("Invalid session response.", true);
  const mode = value.mode as RoomAccess["mode"];
  return { token: value.token, expires: value.expires, mode, iceTransportPolicy: value.iceTransportPolicy as RTCIceTransportPolicy,
    iceServers: validateIceServers(value.iceServers, mode === "internet") };
}
function events(value: unknown): RoomEvent[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 160) throw new RoomError("Invalid signaling events.", true);
  return value.map((e: Record<string, unknown>) => {
    if (!Number.isSafeInteger(e?.sequence) || Number(e.sequence) < 1 || !["offer", "answer", "candidate"].includes(String(e.kind)) ||
      e.kind !== "candidate" && (typeof e.value !== "string" || e.value.length > 65_536)) throw new RoomError("Invalid signaling event.", true);
    return { sequence: Number(e.sequence), kind: e.kind as RoomEvent["kind"], value: e.kind === "candidate" ? parseCandidate(e.value) : e.value as string };
  });
}
export async function createRoom(signal: AbortSignal): Promise<RoomAccess & { key: string }> {
  const value = await request({ action: "create" }, signal);
  if (typeof value.key !== "string" || !validJoinKey(value.key)) throw new RoomError("Invalid session-key response.", true);
  return { ...access(value), key: value.key };
}
export async function joinRoom(key: string, signal: AbortSignal): Promise<RoomAccess & { events: RoomEvent[] }> {
  if (!validJoinKey(key)) throw new RoomError("Enter the 12-character session key shown by the host.", true);
  const value = await request({ action: "join", key: normalizeJoinKey(key) }, signal);
  return { ...access(value), events: events(value.events) };
}
export async function readEvents(token: string, after: number, signal: AbortSignal): Promise<RoomEvent[]> {
  return events((await request({ action: "events", token, after }, signal, true)).events);
}
export async function sendSignal(token: string, kind: RoomEvent["kind"], value: RoomEvent["value"], signal: AbortSignal): Promise<void> {
  await request({ action: "signal", token, kind, value }, signal);
}
export function leaveRoom(token: string): void {
  void fetch(ROOM_PATH, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "leave", token }),
    credentials: "omit", keepalive: true }).catch(() => undefined);
}

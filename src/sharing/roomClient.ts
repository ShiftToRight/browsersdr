const PATH = "/api/local-sharing/v1";
export const normalizeJoinKey = (value: string): string => value.toUpperCase().replace(/[\s-]/g, "");
export const validJoinKey = (value: string): boolean => /^[2-9A-HJ-NP-Z]{12}$/.test(normalizeJoinKey(value));
export const formatJoinKey = (value: string): string => normalizeJoinKey(value).match(/.{1,4}/g)?.join("-") ?? "";
async function request(body: object, signal?: AbortSignal): Promise<Record<string, unknown>> {
  const response = await fetch(PATH, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), credentials: "omit", cache: "no-store", signal });
  if (response.status === 204) return {};
  let value: Record<string, unknown>;
  try { value = await response.json() as Record<string, unknown>; }
  catch { throw new Error("This preview has no session-key service. Open the updated local preview."); }
  if (!response.ok) throw new Error(typeof value.error === "string" ? value.error : "Session exchange failed.");
  return value;
}
export async function createRoom(offer: string, signal: AbortSignal): Promise<{ key: string; token: string }> {
  const value = await request({ action: "create", offer }, signal);
  if (typeof value.key !== "string" || !validJoinKey(value.key) || typeof value.token !== "string") throw new Error("Invalid session-key response.");
  return { key: value.key, token: value.token };
}
export async function joinRoom(key: string, signal: AbortSignal): Promise<{ offer: string; token: string }> {
  if (!validJoinKey(key)) throw new Error("Enter the 12-character session key shown by the host.");
  const value = await request({ action: "join", key: normalizeJoinKey(key) }, signal);
  if (typeof value.offer !== "string" || typeof value.token !== "string") throw new Error("Invalid session response.");
  return { offer: value.offer, token: value.token };
}
export async function waitForAnswer(token: string, signal: AbortSignal): Promise<string> {
  while (!signal.aborted) { const value = await request({ action: "wait", token }, signal); if (typeof value.answer === "string") return value.answer; }
  throw new DOMException("Connection closed.", "AbortError");
}
export async function sendAnswer(token: string, answer: string, signal: AbortSignal): Promise<void> { await request({ action: "answer", token, answer }, signal); }
export function leaveRoom(token: string): void {
  void fetch(PATH, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "leave", token }), credentials: "omit", keepalive: true }).catch(() => undefined);
}

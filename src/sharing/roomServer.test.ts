import { EventEmitter } from "node:events";
import { afterEach, expect, it, vi } from "vitest";
import type { IncomingMessage, ServerResponse } from "node:http";
import { createRoomService, ROOM_PATH } from "./roomServer";
import { formatJoinKey, normalizeJoinKey, validJoinKey } from "./roomClient";

const services: ReturnType<typeof createRoomService>[] = [];
afterEach(() => { services.forEach(service => service.close()); services.length = 0; vi.useRealTimers(); });
function service() { const result = createRoomService(); services.push(result); return result; }
function signal(type: "offer" | "answer", id = "ab".repeat(16)) { return JSON.stringify({ schema: "browsersdr-peer-prototype-v1", id, description: { type, sdp: "v=0\r\na=temporary-local-description\r\n" } }); }
function call(s: ReturnType<typeof createRoomService>, body: unknown, options: { origin?: string; ip?: string; method?: string; type?: string } = {}) {
  let status = 0, text = "", done = false;
  const request = Object.assign(new EventEmitter(), { url: ROOM_PATH, method: options.method ?? "POST", headers: { host: "127.0.0.1:43523", origin: options.origin ?? "http://127.0.0.1:43523", "content-type": options.type ?? "application/json" }, socket: { remoteAddress: options.ip ?? "loopback" }, setEncoding: () => {} });
  const response = Object.assign(new EventEmitter(), { destroyed: false, writableEnded: false,
    writeHead: (code: number) => { status = code; }, end: (value?: string) => { text = value ?? ""; done = true; response.writableEnded = true; response.emit("close"); } });
  s.middleware(request as unknown as IncomingMessage, response as unknown as ServerResponse, () => { throw new Error("Unexpected route"); });
  request.emit("data", typeof body === "string" ? body : JSON.stringify(body)); request.emit("end");
  return { get status() { return status; }, get done() { return done; }, get body(): Record<string, string> { return text ? JSON.parse(text) as Record<string, string> : {}; }, close: () => response.emit("close") };
}
it("a single normalized key delivers the offer once, authenticates roles and wakes the waiting host immediately", () => {
  const s = service(), room = call(s, { action: "create", offer: signal("offer") }).body;
  expect(validJoinKey(room.key!)).toBe(true); expect(formatJoinKey(room.key!)).toHaveLength(14);
  const waiting = call(s, { action: "wait", token: room.token }); expect(waiting.done).toBe(false);
  const joined = call(s, { action: "join", key: formatJoinKey(room.key!).toLowerCase() }).body;
  expect(joined.offer).toBe(signal("offer")); expect(joined.token).not.toBe(room.token);
  expect(call(s, { action: "join", key: room.key }).status).toBe(409);
  expect(call(s, { action: "answer", token: room.token, answer: signal("answer") }).status).toBe(403);
  expect(call(s, { action: "answer", token: joined.token, answer: signal("answer", "cd".repeat(16)) }).status).toBe(400);
  expect(call(s, { action: "answer", token: joined.token, answer: signal("answer") }).status).toBe(200);
  expect(waiting.done).toBe(true); expect(waiting.body.answer).toBe(signal("answer"));
  expect(call(s, { action: "wait", token: room.token }).status).toBe(410);
});
it("expired and stopped rooms cannot be joined; polling is bounded without disclosing tokens", async () => {
  vi.useFakeTimers(); const s = service();
  const first = call(s, { action: "create", offer: signal("offer") }).body;
  const waiting = call(s, { action: "wait", token: first.token });
  await vi.advanceTimersByTimeAsync(20_001); expect(waiting.status).toBe(204);
  await vi.advanceTimersByTimeAsync(600_000); expect(call(s, { action: "join", key: first.key }).status).toBe(404);
  const second = call(s, { action: "create", offer: signal("offer") }).body;
  const next = call(s, { action: "wait", token: second.token });
  expect(call(s, { action: "leave", token: "wrong" }).status).toBe(410);
  expect(call(s, { action: "leave", token: second.token }).status).toBe(200); expect(next.status).toBe(410);
  expect(call(s, { action: "join", key: second.key }).status).toBe(404);
});
it("rejects cross-origin writes, non-JSON, oversized messages and repeated key guessing", () => {
  const s = service();
  expect(call(s, {}, { origin: "https://attacker.invalid" }).status).toBe(403);
  expect(call(s, {}, { method: "GET" }).status).toBe(405);
  expect(call(s, {}, { type: "text/plain" }).status).toBe(415);
  expect(call(s, "x".repeat(75_001)).status).toBe(413);
  for (let i = 0; i < 30; i++) expect(call(s, { action: "join", key: "ZZZZZZZZZZZZ" }).status).toBe(404);
  expect(call(s, { action: "join", key: "ZZZZZZZZZZZZ" }).status).toBe(429);
  expect(normalizeJoinKey(" abcd-efgh 2345 ")).toBe("ABCDEFGH2345");
});
it("an abandoned long poll frees its slot and server close ends pending exchanges", () => {
  const s = service(), room = call(s, { action: "create", offer: signal("offer") }).body;
  const first = call(s, { action: "wait", token: room.token }); first.close();
  const second = call(s, { action: "wait", token: room.token }); expect(second.done).toBe(false);
  s.close(); expect(second.status).toBe(410);
});

import { randomBytes } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { parseSignal } from "./signalingProtocol";

/** Local rendezvous only: no audio, spectrum, storage or public room directory. */
export const ROOM_PATH = "/api/local-sharing/v1";
const ALPHABET = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ";
type Room = { offer: string; key: string; host: string; guest?: string; answer?: string; expires: number; waiting?: ServerResponse };
export function createRoomService() {
  const rooms = new Map<string, Room>();
  const tokens = new Map<string, Room>();
  const attempts = new Map<string, { time: number; count: number }>();
  const reply = (res: ServerResponse, status: number, body?: unknown) => {
    if (res.destroyed || res.writableEnded) return;
    res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" });
    res.end(body === undefined ? undefined : JSON.stringify(body));
  };
  const remove = (room: Room) => {
    rooms.delete(room.key); tokens.delete(room.host); if (room.guest) tokens.delete(room.guest);
    if (room.waiting) reply(room.waiting, 410, { error: "Session key expired or sharing stopped. Ask the host for a new key." });
    room.waiting = undefined;
  };
  const sweep = () => {
    const now = Date.now();
    for (const room of rooms.values()) if (room.expires <= now) remove(room);
    for (const [ip, counter] of attempts) if (now - counter.time > 60_000) attempts.delete(ip);
  };
  const timer = setInterval(sweep, 5000); timer.unref();
  const middleware = (req: IncomingMessage, res: ServerResponse, next: () => void) => {
    if (req.url?.split("?")[0] !== ROOM_PATH) { next(); return; }
    if (req.method !== "POST") { reply(res, 405, { error: "Use a sharing client." }); return; }
    let origin: URL;
    try { origin = new URL(String(req.headers.origin)); } catch { reply(res, 403, { error: "Same-origin requests required." }); return; }
    if (origin.host !== req.headers.host || !["http:", "https:"].includes(origin.protocol)) { reply(res, 403, { error: "Same-origin requests required." }); return; }
    if (!/^application\/json(?:;|$)/i.test(req.headers["content-type"] ?? "")) { reply(res, 415, { error: "JSON required." }); return; }
    sweep();
    let bytes = 0, body = "";
    req.setEncoding("utf8");
    req.on("data", (chunk: string) => {
      bytes += Buffer.byteLength(chunk);
      if (bytes > 75_000) { reply(res, 413, { error: "Request too large." }); return; }
      body += chunk;
    });
    req.on("end", () => {
      if (res.writableEnded) return;
      try {
        const value = JSON.parse(body) as Record<string, unknown>;
        if (!value || typeof value !== "object") throw new Error();
        if (value.action === "create" || value.action === "join") {
          const ip = req.socket.remoteAddress ?? "unknown";
          const counter = attempts.get(ip) ?? { time: Date.now(), count: 0 };
          if (counter.count >= 30 || attempts.size >= 256 && !attempts.has(ip)) { reply(res, 429, { error: "Too many attempts. Try again in a minute." }); return; }
          counter.count++; attempts.set(ip, counter);
        }
        if (value.action === "create") {
          if (rooms.size >= 32) { reply(res, 503, { error: "Sharing is busy. Try again shortly." }); return; }
          if (typeof value.offer !== "string") throw new Error();
          parseSignal(value.offer, "offer");
          let key: string;
          do { key = Array.from(randomBytes(12), b => ALPHABET[b & 31]).join(""); } while (rooms.has(key));
          const room: Room = { key, offer: value.offer, host: randomBytes(24).toString("hex"), expires: Date.now() + 600_000 };
          rooms.set(key, room); tokens.set(room.host, room);
          reply(res, 201, { key, token: room.host, expires: room.expires }); return;
        }
        if (value.action === "join") {
          const key = typeof value.key === "string" ? value.key.toUpperCase().replace(/[\s-]/g, "") : "";
          const room = /^[2-9A-HJ-NP-Z]{12}$/.test(key) ? rooms.get(key) : undefined;
          if (!room) { reply(res, 404, { error: "Session key not found or expired. Check the key with the host." }); return; }
          if (room.guest) { reply(res, 409, { error: "This session already has a guest. Ask the host for a new key." }); return; }
          room.guest = randomBytes(24).toString("hex"); tokens.set(room.guest, room);
          reply(res, 200, { offer: room.offer, token: room.guest }); return;
        }
        const room = typeof value.token === "string" ? tokens.get(value.token) : undefined;
        if (!room) { reply(res, 410, { error: "Session key expired or sharing stopped. Ask the host for a new key." }); return; }
        if (value.action === "answer" && value.token === room.guest) {
          if (typeof value.answer !== "string") throw new Error();
          const answer = parseSignal(value.answer, "answer"), offer = parseSignal(room.offer, "offer");
          if (answer.id !== offer.id) throw new Error();
          room.answer = value.answer; reply(res, 200, { ok: true });
          if (room.waiting) { const waiting = room.waiting; room.waiting = undefined; reply(waiting, 200, { answer: room.answer }); remove(room); }
          return;
        }
        if (value.action === "wait" && value.token === room.host) {
          if (room.answer) { reply(res, 200, { answer: room.answer }); remove(room); return; }
          if (room.waiting) { reply(res, 409, { error: "A connection exchange is already waiting." }); return; }
          room.waiting = res;
          const wait = setTimeout(() => { if (room.waiting === res) { room.waiting = undefined; reply(res, 204); } }, 20_000);
          res.once("close", () => { clearTimeout(wait); if (room.waiting === res) room.waiting = undefined; });
          return;
        }
        if (value.action === "leave") { reply(res, 200, { ok: true }); remove(room); return; }
        reply(res, 403, { error: "This role cannot perform that operation." });
      } catch { reply(res, 400, { error: "Invalid connection exchange." }); }
    });
  };
  return { middleware, close: () => { clearInterval(timer); for (const room of rooms.values()) remove(room); } };
}

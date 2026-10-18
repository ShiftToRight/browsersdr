import { afterEach, expect, it, vi } from "vitest";
import { createRoom, joinRoom, readEvents, sendSignal, leaveRoom, RoomError, validJoinKey, formatJoinKey } from "./roomClient";
const token = "ab".repeat(24), signal = () => new AbortController().signal;
const response = (extra: object = {}) => ({ token, key: "2345ABCDEFGH", expires: Date.now() + 7200000,
  iceServers: [], iceTransportPolicy: "all", mode: "local", ...extra });
afterEach(() => vi.unstubAllGlobals());
it("uses the public same-origin API, role token bodies and no cookies, with a key-only join", async () => {
  const fetcher = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => Response.json(response())); vi.stubGlobal("fetch", fetcher);
  const room = await createRoom(signal()); expect(validJoinKey(room.key)).toBe(true); expect(formatJoinKey(room.key)).toHaveLength(14);
  expect(fetcher).toHaveBeenCalledWith("/api/v1/sharing", expect.objectContaining({ credentials: "omit", cache: "no-store", body: JSON.stringify({ action: "create" }) }));
  await joinRoom("2345-abcd-efgh", signal()); expect(JSON.parse(fetcher.mock.calls.at(-1)![1]!.body as string)).toEqual({ action: "join", key: "2345ABCDEFGH" });
});
it("validates public TURN configuration, filters unexpected fields and never accepts unauthenticated relay URLs", async () => {
  const urls = ["turn:relay.example:3478?transport=udp", "turns:relay.example:5349?transport=tcp"];
  vi.stubGlobal("fetch", async () => Response.json(response({ mode: "internet", iceServers: [{ urls, username: "temporary", credential: "temporary", privateSecret: "never" }] })));
  const room = await createRoom(signal()); expect(room.iceServers[0]).not.toHaveProperty("privateSecret");
  vi.stubGlobal("fetch", async () => Response.json(response({ mode: "internet", iceServers: [{ urls }] })));
  await expect(createRoom(signal())).rejects.toThrow("credentials");
  vi.stubGlobal("fetch", async () => Response.json(response({ mode: "internet" })));
  await expect(createRoom(signal())).rejects.toThrow("TURN/UDP");
});
it("bounds and validates candidate events and preserves long-poll cursor acknowledgments", async () => {
  const candidate = { candidate: "candidate:1 1 UDP 1 192.0.2.1 1234 typ relay", sdpMid: "0", sdpMLineIndex: 0 };
  const fetcher = vi.fn(async () => Response.json({ events: [{ sequence: 7, kind: "candidate", value: candidate }] })); vi.stubGlobal("fetch", fetcher);
  expect(await readEvents(token, 6, signal())).toEqual([{ sequence: 7, kind: "candidate", value: candidate }]);
  await sendSignal(token, "candidate", candidate, signal()); expect(fetcher).toHaveBeenLastCalledWith("/api/v1/sharing", expect.objectContaining({ body: JSON.stringify({ action: "signal", token, kind: "candidate", value: candidate }) }));
  vi.stubGlobal("fetch", async () => Response.json({ events: [{ sequence: -1, kind: "offer", value: "invalid" }] }));
  await expect(readEvents(token, 0, signal())).rejects.toThrow("Invalid signaling");
});
it("distinguishes terminal expiration from provider failure and aborts through the caller signal", async () => {
  vi.stubGlobal("fetch", async () => Response.json({ error: "expired" }, { status: 410 }));
  await expect(createRoom(signal())).rejects.toMatchObject({ terminal: true, status: 410 });
  vi.stubGlobal("fetch", async () => Response.json({ error: "busy" }, { status: 503 }));
  await expect(createRoom(signal())).rejects.toMatchObject({ terminal: false });
  vi.stubGlobal("fetch", async () => new Response(null, { status: 204 })); expect(await readEvents(token, 0, signal())).toEqual([]);
  const fetcher = vi.fn(async () => Response.json({ ok: true })); vi.stubGlobal("fetch", fetcher); leaveRoom(token);
  expect(fetcher).toHaveBeenCalledWith("/api/v1/sharing", expect.objectContaining({ keepalive: true, credentials: "omit" }));
  expect(new RoomError("reason", true)).toBeInstanceOf(Error);
});

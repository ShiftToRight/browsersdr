import { randomBytes } from "node:crypto";
import type { BrowserContext } from "@playwright/test";

/** Browser-contract fixture only. Release integration sets BSD_E2E_SHARING_REAL=1. */
export function sharingSignalingFixture() {
  type Event = { sequence: number; kind: string; value: unknown };
  type Peer = { token: string; events: Event[]; sequence: number };
  type Room = {
    key: string;
    host: Peer;
    guest?: Peer;
    pending: Event[];
    ended: boolean;
  };
  const rooms = new Map<string, Room>(),
    peers = new Map<string, { room: Room; peer: Peer }>();
  const peer = (): Peer => ({
    token: randomBytes(24).toString("hex"),
    events: [],
    sequence: 0,
  });
  const access = (p: Peer) => ({
    token: p.token,
    expires: Date.now() + 7_200_000,
    iceServers: [],
    iceTransportPolicy: "all",
    mode: "local",
  });
  return {
    async install(context: BrowserContext) {
      if (process.env.BSD_E2E_SHARING_REAL === "1") return;
      await context.route("**/api/v1/sharing", async (route) => {
        const v = route.request().postDataJSON() as {
          action: string;
          key?: string;
          token?: string;
          after?: number;
          kind?: string;
          value?: unknown;
        };
        let status = 200,
          body: object | undefined;
        if (v.action === "create") {
          const alphabet = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ";
          const key = Array.from(randomBytes(12), (b) => alphabet[b & 31]).join(
            "",
          );
          const room: Room = { key, host: peer(), pending: [], ended: false };
          rooms.set(key, room);
          peers.set(room.host.token, { room, peer: room.host });
          status = 201;
          body = { ...access(room.host), key };
        } else if (v.action === "join") {
          const room = rooms.get(v.key!.toUpperCase().replace(/[\s-]/g, ""));
          if (!room || room.ended || room.guest) {
            status = 404;
            body = {
              error:
                "Session key not found or expired. Check the key with the host.",
            };
          } else {
            room.guest = peer();
            peers.set(room.guest.token, { room, peer: room.guest });
            room.guest.events = room.pending;
            room.guest.sequence = room.pending.length;
            room.pending = [];
            body = { ...access(room.guest), events: room.guest.events };
          }
        } else {
          const a = peers.get(v.token!);
          if (!a || a.room.ended) {
            status = 410;
            body = {
              error: "Sharing ended or expired. Ask the host for a new key.",
            };
          } else if (v.action === "leave") {
            a.room.ended = true;
            body = { ok: true };
          } else if (v.action === "signal") {
            if (a.peer === a.room.host && !a.room.guest)
              a.room.pending.push({
                sequence: a.room.pending.length + 1,
                kind: v.kind!,
                value: v.value,
              });
            else {
              const target =
                a.peer === a.room.host ? a.room.guest! : a.room.host;
              target.events.push({
                sequence: ++target.sequence,
                kind: v.kind!,
                value: v.value,
              });
            }
            body = { ok: true };
          } else if (v.action === "events") {
            // Keep polls outstanding briefly so a real browser event loop still runs normally.
            await new Promise((resolve) => setTimeout(resolve, 100));
            if (a.room.ended) {
              status = 410;
              body = {
                error: "Sharing ended or expired. Ask the host for a new key.",
              };
            } else {
              a.peer.events = a.peer.events.filter(
                (e) => e.sequence > (v.after ?? 0),
              );
              body = a.peer.events.length
                ? { events: a.peer.events }
                : undefined;
              if (!body) status = 204;
            }
          } else {
            status = 400;
            body = { error: "Unknown fixture action." };
          }
        }
        await route
          .fulfill({
            status,
            contentType: "application/json",
            headers: { "Cache-Control": "no-store" },
            body: body ? JSON.stringify(body) : undefined,
          })
          .catch(() => undefined);
      });
    },
  };
}

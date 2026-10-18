import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { sharingCheckProxy } from "./sharing-check-proxy.mjs";

test("a full stamped run requires an actual loopback service and disabled fixture", () => {
  assert.throws(() => sharingCheckProxy({}, true), /actual sharing service/);
  assert.equal(sharingCheckProxy({})({}, {}), false);
  assert.throws(
    () => sharingCheckProxy({ BSD_SHARING_CHECK_PROXY: "http://127.0.0.1:1" }),
    /disable/,
  );
  for (const endpoint of [
    "https://example.org",
    "http://example.org",
    "http://user:secret@127.0.0.1",
    "http://127.0.0.1/api",
    "http://127.0.0.1?token=secret",
  ])
    assert.throws(
      () =>
        sharingCheckProxy({
          BSD_SHARING_CHECK_PROXY: endpoint,
          BSD_E2E_SHARING_REAL: "1",
        }),
      /loopback/,
    );
});

test("real HTTP signaling preserves origin and body, strips identity headers and exposes no backend health", async (t) => {
  let received;
  const backend = createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => {
      body += chunk;
    });
    request.once("end", () => {
      received = { headers: request.headers, path: request.url, body };
      response.writeHead(201);
      response.end(JSON.stringify({ key: "2345ABCDEFGH" }));
    });
  });
  await new Promise((resolve) => backend.listen(0, "127.0.0.1", resolve));
  t.after(() => {
    backend.closeAllConnections();
    backend.close();
  });
  const proxy = sharingCheckProxy(
    {
      BSD_SHARING_CHECK_PROXY: `http://127.0.0.1:${backend.address().port}`,
      BSD_E2E_SHARING_REAL: "1",
    },
    true,
  );
  const site = createServer((request, response) => {
    if (!proxy(request, response)) {
      response.writeHead(404);
      response.end();
    }
  });
  await new Promise((resolve) => site.listen(0, "127.0.0.1", resolve));
  t.after(() => {
    site.closeAllConnections();
    site.close();
  });
  const origin = `http://127.0.0.1:${site.address().port}`;
  const response = await fetch(origin + "/api/v1/sharing", {
    method: "POST",
    headers: {
      origin,
      "content-type": "application/json",
      cookie: "private",
      authorization: "private",
      "x-forwarded-for": "192.0.2.1",
      "x-browsersdr-client-ip": "192.0.2.2",
    },
    body: '{"action":"create"}',
  });
  assert.equal(response.status, 201);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.equal((await response.json()).key, "2345ABCDEFGH");
  assert.equal(received.headers.origin, origin);
  assert.equal(received.headers.host, new URL(origin).host);
  assert.equal(received.path, "/api/v1/sharing");
  assert.equal(received.body, '{"action":"create"}');
  for (const name of [
    "cookie",
    "authorization",
    "x-forwarded-for",
    "x-browsersdr-client-ip",
  ])
    assert.equal(received.headers[name], undefined);
  assert.equal((await fetch(origin + "/health")).status, 404);
  assert.equal((await fetch(origin + "/api/v1/sharing")).status, 405);
});

import { request as upstreamRequest } from "node:http";

// The private operator starts the isolated service. Public tests never import it.
export function sharingCheckProxy(env, required = false) {
  const endpoint = env.BSD_SHARING_CHECK_PROXY;
  if (!endpoint) {
    if (required)
      throw new Error(
        "Full stamped integration requires the actual sharing service.",
      );
    return () => false;
  }
  const target = new URL(endpoint);
  if (
    target.protocol !== "http:" ||
    !["127.0.0.1", "[::1]"].includes(target.hostname) ||
    target.username ||
    target.password ||
    target.pathname !== "/" ||
    target.search ||
    target.hash
  )
    throw new Error(
      "Sharing integration proxy must be an explicit loopback HTTP origin.",
    );
  if (env.BSD_E2E_SHARING_REAL !== "1")
    throw new Error(
      "Actual sharing integration must disable the public signaling fixture.",
    );
  return (request, response) => {
    if (request.url?.split("?")[0] !== "/api/v1/sharing") return false;
    if (request.method !== "POST") {
      response.writeHead(405);
      response.end();
      return true;
    }
    const headers = { ...request.headers };
    for (const name of [
      "cookie",
      "authorization",
      "forwarded",
      "x-forwarded-for",
      "x-real-ip",
      "x-browsersdr-client-ip",
    ])
      delete headers[name];
    const upstream = upstreamRequest(
      new URL("/api/v1/sharing", target),
      {
        method: "POST",
        headers,
        timeout: 35_000,
      },
      (result) => {
        response.writeHead(result.statusCode ?? 502, {
          "Content-Type": "application/json",
          "Cache-Control": "no-store",
        });
        result.pipe(response);
      },
    );
    const fail = () => {
      if (!response.headersSent)
        response.writeHead(502, {
          "Content-Type": "application/json",
          "Cache-Control": "no-store",
        });
      if (!response.writableEnded)
        response.end(
          JSON.stringify({ error: "Isolated sharing service unavailable." }),
        );
    };
    upstream.once("error", fail);
    upstream.once("timeout", () =>
      upstream.destroy(new Error("Sharing proxy timeout")),
    );
    response.once("close", () => {
      if (!response.writableEnded) upstream.destroy();
    });
    request.pipe(upstream);
    return true;
  };
}

import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const LOCAL_USRP_PREFIX = "/local/usrp-b205/";
const LOCAL_USRP_ARTIFACTS = new Set(["ad9364-no-os.js", "ad9364-no-os.wasm"]);
const localUsrpDirectory = fileURLToPath(new URL("./.local/usrp-b205/", import.meta.url));
const ASYNCIFY_READY_MARKER = "wasmExports=await (createWasm());run();";

function prepareLocalNoOsJavascript(bytes: Buffer): Buffer {
  const source = bytes.toString("utf8");
  if (!source.includes(ASYNCIFY_READY_MARKER)) {
    throw new Error("Local USRP no-OS module does not have the pinned Asyncify wrapper shape.");
  }
  return Buffer.from(source.replace(
    ASYNCIFY_READY_MARKER,
    `${ASYNCIFY_READY_MARKER}Module["awaitAsyncify"]=(result)=>Asyncify.currData?Asyncify.whenDone():Promise.resolve(result);`,
  ));
}

export default defineConfig({
  // Keep the app, stylesheet and module worker relocatable as one static directory.
  base: "./",
  plugins: [
    react(),
    {
      name: "local-usrp-b205-no-os",
      apply: "serve",
      configureServer(server) {
        server.middlewares.use((request, response, next) => {
          const pathname = new URL(request.url ?? "/", "http://localhost").pathname;
          if (!pathname.startsWith(LOCAL_USRP_PREFIX)) return next();
          const artifact = pathname.slice(LOCAL_USRP_PREFIX.length);
          if (!LOCAL_USRP_ARTIFACTS.has(artifact)) return next();
          void readFile(new URL(artifact, `file://${localUsrpDirectory}`)).then(
            (bytes) => {
              const body = artifact.endsWith(".js") ? prepareLocalNoOsJavascript(bytes) : bytes;
              response.statusCode = 200;
              response.setHeader(
                "Content-Type",
                artifact.endsWith(".wasm") ? "application/wasm" : "text/javascript; charset=utf-8",
              );
              response.setHeader("Cache-Control", "no-store");
              response.end(body);
            },
            () => {
              response.statusCode = 404;
              response.end("Local USRP test artifact not built.");
            },
          );
        });
      },
    },
  ],
});

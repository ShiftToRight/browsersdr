import { verifyBuildReceipt } from "./browser-build.mjs";

export function browserServers(root, env = process.env) {
  const target = env.BSD_E2E_TARGET;
  if (target && !["chromium-dev", "chromium-production"].includes(target))
    throw new Error("Unknown browser server target");
  const port = (name, fallback) => {
    const value = Number(env[name] ?? fallback);
    if (!Number.isSafeInteger(value) || value < 1 || value > 65535)
      throw new Error(`Invalid ${name}`);
    return value;
  };
  const dev = port("BSD_E2E_DEV_PORT", 43173),
    prod = port("BSD_E2E_PRODUCTION_PORT", 43174);
  const servers = [];
  if (target !== "chromium-production")
    servers.push({
      name: "vite-development",
      command: `npm run dev -- --host 127.0.0.1 --port ${dev} --strictPort`,
      url: `http://127.0.0.1:${dev}`,
      reuseExistingServer: false,
      timeout: 120_000,
    });
  if (target !== "chromium-dev") {
    if (env.BSD_E2E_BUILD_RECEIPT)
      verifyBuildReceipt(root, env.BSD_E2E_BUILD_RECEIPT, env);
    servers.push({
      name: "vite-production-preview",
      command: `${env.BSD_E2E_BUILD_RECEIPT ? "" : "npm run build && "}npm run preview -- --host 127.0.0.1 --port ${prod} --strictPort`,
      url: `http://127.0.0.1:${prod}`,
      reuseExistingServer: false,
      timeout: 120_000,
    });
  }
  return servers;
}

import { spawn } from "node:child_process";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  allowedSkips,
  assertComplete,
  assertInventory,
  digest,
  verificationDigest,
} from "./browser-coverage.mjs";
import { verifyBuildReceipt } from "./browser-build.mjs";

export function execute(command, args, options) {
  return new Promise((resolve, reject) => {
    const { quiet = false, logFile, ...spawnOptions } = options;
    // A nested Node test worker must not write its binary test-runner protocol
    // into its parent's reporter stream. Playwright is a separate CLI process.
    const env = { ...spawnOptions.env };
    delete env.NODE_TEST_CONTEXT;
    const child = spawn(command, args, {
      ...spawnOptions,
      env,
      stdio: ["inherit", "pipe", "pipe"],
    });
    for (const [stream, destination] of [
      [child.stdout, process.stdout],
      [child.stderr, process.stderr],
    ])
      stream.on("data", (data) => {
        if (logFile) appendFileSync(logFile, data);
        if (!quiet) destination.write(data);
      });
    const interrupt = () => child.kill("SIGINT");
    const terminate = () => child.kill("SIGTERM");
    process.once("SIGINT", interrupt);
    process.once("SIGTERM", terminate);
    child.once("error", reject);
    child.once("close", (code, signal) => {
      process.removeListener("SIGINT", interrupt);
      process.removeListener("SIGTERM", terminate);
      resolve({ code, signal });
    });
  });
}

export async function runBrowserChecks({
  root = process.cwd(),
  config = join(root, "playwright.config.ts"),
  project,
  shard,
  output,
  env = process.env,
  globalTimeoutMs = 25 * 60_000,
  quiet = false,
  inventoryCheck,
}) {
  if (
    !Number.isSafeInteger(globalTimeoutMs) ||
    globalTimeoutMs <= 0 ||
    globalTimeoutMs > 25 * 60_000
  )
    throw new Error(
      "Browser suite timeout must be positive and at most 25 minutes",
    );
  output = resolve(output ?? join(root, "test-results/browser-check"));
  if (existsSync(output))
    throw new Error(`Use a fresh browser output directory: ${output}`);
  mkdirSync(output, { recursive: true });
  const cli = join(root, "node_modules/@playwright/test/cli.js");
  const reporter = join(root, "scripts/browser-coverage-reporter.mjs");
  const args = [
    cli,
    "test",
    "--config",
    config,
    "--forbid-only",
    "--fail-on-flaky-tests",
  ];
  if (project) args.push(`--project=${project}`);
  const environment = {
    node: process.version,
    platform: process.platform,
    arch: process.arch,
    playwright: JSON.parse(
      readFileSync(join(root, "node_modules/@playwright/test/package.json")),
    ).version,
    optionalAtlas: Boolean(env.BSD04_CONTEXT),
    optionalBladeRf: Boolean(env.BLADERF_OFFICIAL_ARTIFACT_DIR),
    buildFlags: Object.fromEntries(
      Object.entries(env)
        .filter(([key]) => key.startsWith("VITE_"))
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, value]) => [key, digest(value)]),
    ),
  };
  const inputDigest = verificationDigest(root);
  const configurationDigest = digest(readFileSync(config).toString("base64"));
  // Set server selection for CLI discovery as well as execution. A shard must
  // never start an unrelated target, and explicit prebuilt bytes fail closed.
  env = { ...env, BSD_E2E_TARGET: project ?? "" };
  const artifact =
    env.BSD_E2E_BUILD_RECEIPT && project !== "chromium-dev"
      ? verifyBuildReceipt(root, env.BSD_E2E_BUILD_RECEIPT, env)
      : undefined;
  async function discover(name, extra = []) {
    const path = join(output, name);
    const result = await execute(
      process.execPath,
      [...args, ...extra, "--list", "--reporter", reporter],
      {
        cwd: root,
        quiet,
        logFile: join(output, "commands.log"),
        env: {
          ...env,
          BSD_BROWSER_DISCOVERY_PATH: path,
          BSD_BROWSER_GUARD_DIR: "",
        },
      },
    );
    if (result.code !== 0) throw new Error("Browser discovery failed");
    const tests = JSON.parse(readFileSync(path));
    assertInventory(tests);
    return tests;
  }
  const full = await discover("full-inventory.json");
  if (inventoryCheck) inventoryCheck(full);
  const shardArgs = shard ? [`--shard=${shard.current}/${shard.total}`] : [];
  const selected = shard
    ? await discover("shard-inventory.json", shardArgs)
    : full;
  const fullIds = new Set(full.map((t) => t.id));
  if (selected.some((t) => !fullIds.has(t.id)))
    throw new Error("Shard includes unknown cases");
  const policy = JSON.parse(
    readFileSync(join(root, "scripts/browser-skip-policy.json")),
  );
  const manifest = {
    schemaVersion: 1,
    inputDigest,
    configurationDigest,
    environment,
    project: project ?? "",
    shard: shard ?? null,
    full,
    selected,
    allowedSkips: allowedSkips(selected, policy, env),
    ...(artifact ? { testedArtifact: artifact } : {}),
  };
  writeFileSync(
    join(output, "manifest.json"),
    JSON.stringify(manifest, null, 2) + "\n",
  );
  writeFileSync(
    join(output, "events.jsonl"),
    JSON.stringify({
      event: "prepared",
      at: new Date().toISOString(),
      inputDigest,
      environment,
      selected: selected.length,
    }) + "\n",
  );
  const result = await execute(
    process.execPath,
    [
      ...args,
      ...shardArgs,
      `--global-timeout=${globalTimeoutMs}`,
      "--reporter",
      `line,html,json,blob,${reporter}`,
      "--output",
      join(output, "artifacts"),
    ],
    {
      cwd: root,
      quiet,
      logFile: join(output, "commands.log"),
      env: {
        ...env,
        BSD_BROWSER_DISCOVERY_PATH: "",
        BSD_BROWSER_GUARD_DIR: output,
        PLAYWRIGHT_HTML_OUTPUT_DIR: join(output, "html"),
        PLAYWRIGHT_HTML_OPEN: "never",
        PLAYWRIGHT_JSON_OUTPUT_FILE: join(output, "results.json"),
        PLAYWRIGHT_BLOB_OUTPUT_DIR: join(output, "blob"),
        PLAYWRIGHT_BLOB_OUTPUT_NAME: `${project || "stamped"}-${shard?.current ?? 1}-of-${shard?.total ?? 1}.zip`,
      },
    },
  );
  const receiptPath = join(output, "coverage-receipt.json");
  if (result.code !== 0 || !existsSync(receiptPath))
    throw new Error(
      `Browser checks failed (${result.code ?? result.signal}); see ${output}`,
    );
  const receipt = JSON.parse(readFileSync(receiptPath));
  assertComplete(manifest, receipt.actual, receipt.status, receipt.errors);
  if (
    receipt.status !== "passed" ||
    verificationDigest(root) !== inputDigest ||
    digest(readFileSync(config).toString("base64")) !== configurationDigest
  )
    throw new Error(
      "Incomplete browser results or verification inputs changed during the run",
    );
  if (
    artifact &&
    JSON.stringify(verifyBuildReceipt(root, env.BSD_E2E_BUILD_RECEIPT, env)) !==
      JSON.stringify(artifact)
  )
    throw new Error("Tested artifact receipt changed during browser checks");
  return { output, receipt };
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const options = {};
  for (const arg of process.argv.slice(2)) {
    if (arg.startsWith("--project=")) options.project = arg.slice(10);
    else if (arg.startsWith("--output=")) options.output = arg.slice(9);
    else if (arg.startsWith("--prebuilt="))
      options.env = {
        ...process.env,
        BSD_E2E_BUILD_RECEIPT: resolve(arg.slice(11)),
      };
    else if (/^--shard=[12]\/2$/.test(arg))
      options.shard = { current: Number(arg[8]), total: 2 };
    else throw new Error(`Unsupported guarded selection: ${arg}`);
  }
  if (
    options.project &&
    !["chromium-dev", "chromium-production"].includes(options.project)
  )
    throw new Error("Unknown browser project");
  if (!options.output)
    options.output = join(
      process.cwd(),
      "test-results",
      `browser-check-${Date.now()}`,
    );
  await runBrowserChecks(options);
}

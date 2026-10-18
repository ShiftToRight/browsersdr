import {
  appendFileSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { assertComplete, testIdentity } from "./browser-coverage.mjs";

export default class CoverageReporter {
  errors = [];

  event(event) {
    appendFileSync(
      join(this.output, "events.jsonl"),
      JSON.stringify({ at: new Date().toISOString(), ...event }) + "\n",
    );
  }

  onBegin(config, suite) {
    this.config = config;
    this.tests = suite.allTests();
    const inventory = this.tests.map((test) =>
      testIdentity(test, config.rootDir),
    );
    const discovery = process.env.BSD_BROWSER_DISCOVERY_PATH;
    if (discovery) {
      mkdirSync(dirname(discovery), { recursive: true });
      writeFileSync(discovery, JSON.stringify(inventory, null, 2) + "\n");
      return;
    }
    this.output = process.env.BSD_BROWSER_GUARD_DIR;
    if (!this.output) return;
    this.manifest = JSON.parse(
      readFileSync(join(this.output, "manifest.json")),
    );
    this.event({
      event: "begin",
      tests: inventory.length,
      workers: config.workers,
      shard: config.shard,
    });
  }

  onTestEnd(test, result) {
    if (!this.output) return;
    this.event({
      event: "test-end",
      identity: testIdentity(test, this.config.rootDir),
      status: result.status,
      retry: result.retry,
      durationMs: result.duration,
      worker: result.workerIndex,
    });
  }

  onTestBegin(test, result) {
    if (this.output)
      this.event({
        event: "test-begin",
        identity: testIdentity(test, this.config.rootDir),
        retry: result.retry,
        worker: result.workerIndex,
      });
  }

  onError(error) {
    this.errors.push(error.message ?? String(error));
    if (this.output) this.event({ event: "error", message: error.message });
  }

  async onEnd(result) {
    if (!this.output) return;
    const actual = this.tests.map((test) => ({
      identity: testIdentity(test, this.config.rootDir),
      expectedStatus: test.expectedStatus,
      annotations: test.annotations,
      results: test.results.map((r) => ({
        status: r.status,
        retry: r.retry,
        durationMs: r.duration,
      })),
    }));
    let status = result.status;
    try {
      assertComplete(this.manifest, actual, status, this.errors);
    } catch (error) {
      status = "failed";
      this.errors.push(error.message);
    }
    const receipt = {
      ...this.manifest,
      status,
      errors: this.errors,
      actual,
      durationMs: result.duration,
      finishedAt: new Date().toISOString(),
    };
    writeFileSync(
      join(this.output, "coverage-receipt.json"),
      JSON.stringify(receipt, null, 2) + "\n",
    );
    this.event({
      event: "end",
      status,
      durationMs: result.duration,
      errors: this.errors,
    });
    if (status !== "passed")
      process.stderr.write(
        `Coverage guard: ${this.errors.join("; ") || status}\n`,
      );
    return { status };
  }
}

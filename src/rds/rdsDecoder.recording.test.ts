import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { expect, it } from "vitest";
import { RdsMultiplexReceiver } from "./rdsMultiplexReceiver";
import { emptyRdsState } from "./rdsDecoder";

// Owner RF evidence stays private. Public checkouts explicitly skip this
// independent off-air regression, while generated tests remain mandatory.
const capture = new URL("../../.local/rds-investigation-2026-10-11/manual-25db.cu8", import.meta.url);
it.skipIf(!existsSync(capture))("decodes the Fritz capture that the original timing loop rejected", async () => {
  const data = await readFile(capture);
  let state = emptyRdsState();
  const receiver = new RdsMultiplexReceiver(value => { state = value; });
  receiver.setSampleRate(2_400_000);
  receiver.setFrequencyOffset(102_600_000 - 102_599_979.85839844);
  for (let start = 0; start < data.length; start += 16_384) {
    const length = Math.min(8192, (data.length - start) / 2);
    const I = new Float32Array(length), Q = new Float32Array(length);
    for (let n = 0; n < length; n++) {
      I[n] = (data[start + n * 2]! - 127.5) / 128;
      Q[n] = (data[start + n * 2 + 1]! - 127.5) / 128;
    }
    receiver.receiveOwnedSamples({ I, Q, frequency: 102_599_979.85839844 });
  }
  // Cross-checked with redsea v1.3.1; no frequency/catalog identity inference.
  expect(state).toMatchObject({ pi: "D333", programmeService: "Fritz" });
  expect(state.validGroups).toBeGreaterThanOrEqual(10);
});

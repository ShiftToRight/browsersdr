import { describe, expect, it } from "vitest";
import {
  captureOrigin,
  CaptureRdsEvidence,
  readReceptionCandidate,
} from "./receptionEvidence";
import { SavedCaptureRds } from "./savedCaptureRds";
import { RdsMultiplexReceiver } from "../rds/rdsMultiplexReceiver";
import { createRdsMultiplexFixture } from "../testing/rdsFixture";
import { floatToCu8Byte } from "./cu8";

describe("saved reception provenance", () => {
  it("keeps hardware, generator and unresolved replay distinct", () => {
    for (const source of ["rtl-sdr", "hackrf", "bladerf", "usrp-b205"] as const)
      expect(captureOrigin(source)).toBe("real");
    expect(captureOrigin("synthetic")).toBe("synthetic");
    expect(captureOrigin("replay")).toBe("unknown");
  });
  it("rejects malformed tuning links and preserves the intended reference separately", () => {
    expect(
      readReceptionCandidate("?station_id=bad&frequency_hz=91400000"),
    ).toBeUndefined();
    expect(
      readReceptionCandidate(
        "?station_id=30000000-0000-4000-8000-000000000001&frequency_hz=NaN",
      ),
    ).toBeUndefined();
    const candidate = readReceptionCandidate(
      "?station_id=30000000-0000-4000-8000-000000000001&station_name=Example&frequency_hz=91400000&mode=WBFM",
    );
    expect(candidate).toMatchObject({
      station_name: "Example",
      frequency_hz: 91400000,
      mode: "WBFM",
    });
  });
  it("bounds observations, rejects missing identity and never claims a range beyond saved samples", () => {
    const evidence = new CaptureRdsEvidence();
    evidence.observe(
      { pi: null, programmeService: "OLD PS", radioText: null, validGroups: 0 },
      100,
    );
    expect(evidence.finish(100)).toEqual([]);
    evidence.observe(
      { pi: "D32C", programmeService: null, radioText: null, validGroups: 1 },
      100,
      "2026-10-05T14:00:00Z",
    );
    evidence.observe(
      {
        pi: "D32C",
        programmeService: "BRF 91.4",
        radioText: null,
        validGroups: 4,
      },
      200,
    );
    expect(evidence.finish(100)).toHaveLength(1);
    expect(evidence.finish(200).at(-1)).toMatchObject({
      pi: "D32C",
      ps: "BRF 91.4",
      sample_start: "0",
      sample_count: "200",
      validation: "crc-offset-validated",
    });
    for (let n = 0; n < 50; n++)
      evidence.observe(
        {
          pi: "D32C",
          programmeService: String(n),
          radioText: null,
          validGroups: n + 5,
        },
        n + 300,
      );
    expect(evidence.finish(1000)).toHaveLength(20);
  });
  it("uses a fresh decoder per capture and retains only the accepted byte prefix", () => {
    const multiplex = createRdsMultiplexFixture();
    const rate = 228000;
    let phase = 0;
    const bytes = new Uint8Array(multiplex.length * 2);
    for (let n = 0; n < multiplex.length; n++) {
      phase += (2 * Math.PI * 30000 * multiplex[n]!) / rate;
      bytes[n * 2] = floatToCu8Byte(Math.cos(phase) * 0.8);
      bytes[n * 2 + 1] = floatToCu8Byte(Math.sin(phase) * 0.8);
    }
    const capture = new SavedCaptureRds(91400000, rate, 91400000);
    capture.accept(bytes);
    const evidence = capture.finish(bytes.length / 2);
    expect(evidence.some((e) => e.pi === "C201" && e.ps === "CODEX FM")).toBe(
      true,
    );
    for (const item of evidence)
      expect(BigInt(item.sample_count)).toBeLessThanOrEqual(
        BigInt(bytes.length / 2),
      );
    const next = new SavedCaptureRds(92400000, rate, 92400000);
    expect(next.finish(100)).toEqual([]);
    // The existing live decoder can have earlier state; it is never supplied to the capture.
    const live = new RdsMultiplexReceiver(() => undefined);
    live.setSampleRate(rate);
    live.receiveMultiplex(multiplex);
    expect(next.finish(100)).toEqual([]);
  });
});

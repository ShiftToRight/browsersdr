import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { expect, it } from "vitest";
import { TextModemCore } from "./receiver";
import { textModemConfiguration } from "./settings";

it("decodes independent PySSTV audio through analytic conversion, interpolation, offset RF and irregular blocks", () => {
  const manifest = JSON.parse(readFileSync(new URL("./fixtures/sstv-m2-reference.json", import.meta.url), "utf8"));
  for (const [name, info] of Object.entries(manifest.files) as [string, { sha256: string }][]) expect(createHash("sha256").update(readFileSync(new URL(`./fixtures/${name}`, import.meta.url))).digest("hex")).toBe(info.sha256);
  const wav = readFileSync(new URL("./fixtures/sstv-m2-reference-analytic.wav", import.meta.url));
  expect(wav.readUInt16LE(22)).toBe(2); expect(wav.readUInt32LE(24)).toBe(8000); expect(wav.readUInt16LE(34)).toBe(16);
  const frames = (wav.length - 44) / 4, rate = 1_024_000;
  const core = new TextModemCore(); core.configure(textModemConfiguration("SSTV", undefined, rate, 4, -37000));
  const rows: Uint8Array[] = [];
  const takeEvents = () => { for (const { value: event } of core.drainEvents()) if (event.type === "row") rows[event.row] = event.pixels; };
  const samples = Math.floor((frames - 1) * rate / 8000);
  for (let first = 0; first < samples; first += 32749) {
    const count = Math.min(32749, samples - first), I = new Float32Array(count), Q = new Float32Array(count);
    for (let n = 0; n < count; n++) {
      const position = (first + n) * 8000 / rate, at = Math.floor(position), fraction = position - at;
      const i = (wav.readInt16LE(44 + at * 4) * (1 - fraction) + wav.readInt16LE(44 + (at + 1) * 4) * fraction) / 32768;
      const q = (wav.readInt16LE(46 + at * 4) * (1 - fraction) + wav.readInt16LE(46 + (at + 1) * 4) * fraction) / 32768;
      const phase = -2 * Math.PI * 37000 * (first + n) / rate;
      I[n] = i * Math.cos(phase) - q * Math.sin(phase); Q[n] = i * Math.sin(phase) + q * Math.cos(phase);
    }
    core.receive({ I, Q, firstSampleIndex: first, generation: 4 }); takeEvents();
  }
  core.flush(); takeEvents();
  const state = core.snapshot().value;
  expect(state.image).toMatchObject({ mode: "Martin M2", width: 160, channels: 3, complete: false });
  expect(rows.length).toBeGreaterThanOrEqual(5);
  for (let bar = 0; bar < 4; bar++) for (let channel = 0; channel < 3; channel++) {
    const pixel = rows[2]![Math.floor(160 * (bar + .5) / 4) * 3 + channel]!;
    if (bar === channel || bar === 3) expect(pixel).toBeGreaterThan(220); else expect(pixel).toBeLessThan(35);
  }
  expect(state.image!.provenance).toMatchObject({ generation: 4, actualInputSampleRateHz: rate, selectedChannelOffsetHz: -37000 });
  expect(state.image!.reason).toContain("End of input");
  expect(core.drainEvents()).toEqual([]);
}, 15000);

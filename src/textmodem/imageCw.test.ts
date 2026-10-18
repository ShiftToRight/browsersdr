import { expect, it } from "vitest";
import { ImageModem, type ImageDecoderCallbacks } from "./imageModem";
import { CwTextDemodulator } from "./cw";
import { TextModemCore } from "./receiver";
import { DEFAULT_IMAGE_SETTINGS, defaultTextModemSettings, textModemConfiguration, type TextMode } from "./settings";
import { cwSegments, martinSegments, toneIqBlocks, wefaxSegments, type ToneSegment } from "../testing/imageCwSignal";
import type { ImageScanEvent } from "./imageTypes";

function imageHarness() {
  const rows: Uint8Array[] = [], starts: unknown[] = [], ends: unknown[] = [];
  let errors = 0;
  const callbacks: ImageDecoderCallbacks = { start: (...args) => starts.push(args), row: (_, pixels) => rows.push(pixels), end: (...args) => ends.push(args), error: () => errors++ };
  return { callbacks, rows, starts, ends, errors: () => errors };
}
function feed(modem: ImageModem, segments: ToneSegment[]) {
  let total = 0, count = 0;
  for (const segment of segments) { total += segment.seconds * 64000; while (count++ < Math.round(total)) modem.push(segment.hz, .65); count--; }
}
it.each(["Martin M1", "Martin M2"] as const)("%s validates VIS, decodes RGB ordering and completes exactly 256 rows", mode => {
  const h = imageHarness(), modem = new ImageModem("SSTV", 64000, undefined, h.callbacks);
  feed(modem, martinSegments(mode, 256));
  expect(h.starts).toEqual([[mode, mode === "Martin M1" ? 320 : 160, 256, 3]]);
  expect(h.rows).toHaveLength(256);
  expect(h.ends).toEqual([[true, "256 scan lines · no image checksum"]]);
  const width = mode === "Martin M1" ? 320 : 160;
  for (let bar = 0; bar < 4; bar++) {
    const x = Math.floor(width * (bar + .5) / 4);
    for (let c = 0; c < 3; c++) expect(h.rows[2]![x * 3 + c]).toBeCloseTo(bar === c || bar === 3 ? 255 : 0, -1);
  }
  expect(h.errors()).toBe(0);
});
it("bad VIS parity never starts an automatic SSTV image", () => {
  const h = imageHarness(), modem = new ImageModem("SSTV", 60000, undefined, h.callbacks);
  // Use matching source rate in this direct tone check.
  for (const segment of martinSegments("Martin M2", 3, true)) for (let n = 0; n < Math.round(segment.seconds * 60000); n++) modem.push(segment.hz, .65);
  expect(h.starts).toHaveLength(0); expect(h.errors()).toBeGreaterThan(0);
});
it("a parity-valid unsupported VIS never becomes a Martin image", () => {
  const h = imageHarness(), modem = new ImageModem("SSTV", 64000, undefined, h.callbacks);
  const segments = martinSegments("Martin M2", 3);
  const bits = [0, 0, 0, 1, 0, 0, 0, 1]; // VIS8 with even parity: deliberately unsupported Robot36.
  for (let n = 0; n < bits.length; n++) segments[4 + n] = { hz: bits[n] ? 1100 : 1300, seconds: .03 };
  feed(modem, segments);
  expect(h.starts).toHaveLength(0); expect(modem.stage).toContain("Unsupported VIS 8");
});
it("manual WEFAX stops at the row limit without inventing a complete image", () => {
  const h = imageHarness(), modem = new ImageModem("WEFAX", 8000, { ...DEFAULT_IMAGE_SETTINGS, ioc: 288, lpm: 240, automatic: false }, h.callbacks);
  for (let n = 0; n <= 2048 * 2000; n++) modem.push(1900, .65);
  expect(h.starts).toEqual([["WEFAX", 904, 2048, 1]]); expect(h.rows).toHaveLength(2048);
  expect(h.ends).toEqual([[false, "2,048-row retention limit · partial image"]]);
});
it("manual Martin M2 joins line sync without accepting an absent VIS header", () => {
  const h = imageHarness(), modem = new ImageModem("SSTV", 64000, { ...DEFAULT_IMAGE_SETTINGS, sstvMode: "Martin M2" }, h.callbacks);
  feed(modem, martinSegments("Martin M2", 4).slice(13));
  modem.flush();
  expect(h.starts).toHaveLength(1); expect(h.rows.length).toBeGreaterThanOrEqual(3);
  expect(h.ends).toEqual([[false, "End of input · partial image"]]);
});
it("an image gap ends the partial raster and automatic SSTV waits for a fresh VIS", () => {
  const core = new TextModemCore(), rate = 1_024_000;
  core.configure(textModemConfiguration("SSTV", undefined, rate, 8));
  let index = 0;
  for (const block of toneIqBlocks(martinSegments("Martin M2", 2), rate, 0)) { core.receive({ ...block, generation: 8, firstSampleIndex: index }); index += block.I.length; core.drainEvents(); }
  const prior = core.snapshot().value.image!;
  expect(prior.rows).toBeGreaterThan(0);
  core.reset({ reason: "source-gap", missingInputSamples: null });
  expect(core.drainEvents().some(event => event.value.type === "end" && event.value.reason.includes("discontinuity"))).toBe(true);
  for (const block of toneIqBlocks(martinSegments("Martin M2", 3).slice(13), rate, 0)) { core.receive({ ...block, generation: 8, firstSampleIndex: index }); index += block.I.length; core.drainEvents(); }
  expect(core.snapshot().value.image).toMatchObject({ id: prior.id, rows: prior.rows, complete: false });
  expect(core.snapshot().value.counters.discontinuities).toBe(1);
  expect(() => core.receive({ I: new Float32Array(10), Q: new Float32Array(10), generation: 7, firstSampleIndex: index })).toThrow(/generation/);
});
it("WEFAX requires APT/phasing, aligns grayscale rows and reports a stop without a checksum claim", () => {
  const h = imageHarness(), modem = new ImageModem("WEFAX", 64000, undefined, h.callbacks);
  feed(modem, wefaxSegments());
  expect(h.starts).toEqual([["WEFAX", 1809, 2048, 1]]);
  expect(h.rows.length).toBeGreaterThanOrEqual(4);
  for (let bar = 0; bar < 4; bar++) expect(h.rows[1]![Math.floor(1809 * (bar + .5) / 4)]).toBeCloseTo(85 * bar, -1);
  expect(h.ends).toEqual([[true, "APT stop detected · no image checksum"]]);
});
it("CW timing decodes a fixed ITU vector at 12, 20 and 35 WPM", () => {
  for (const wpm of [12, 20, 35]) {
    let text = "";
    const modem = new CwTextDemodulator(64000, { wpm, threshold: .35, autoSpeed: false }, value => text += value, () => {});
    for (const segment of cwSegments(wpm)) for (let n = 0; n < Math.round(segment.seconds * 64000); n++) modem.push(segment.amplitude === 0 ? 0 : .65, 0);
    modem.flush(); expect(text.trim()).toBe("SOS TEST 123");
  }
});
it.each([1_024_000, 2_400_000, 3_200_000])("all three raw-I/Q routes preserve selected offset at %i samples/s and keep images partial at EOF", rate => {
  for (const mode of ["WEFAX", "SSTV", "CW-TEXT"] as TextMode[]) {
    const settings = { ...defaultTextModemSettings(), image: { ...DEFAULT_IMAGE_SETTINGS, automatic: false } };
    const core = new TextModemCore(); core.configure(textModemConfiguration(mode, settings, rate, 7, 37000));
    let index = 0;
    const events: ImageScanEvent[] = [];
    const segments = mode === "WEFAX" ? wefaxSegments(false, 2) : mode === "SSTV" ? martinSegments("Martin M2", 3) : cwSegments(20);
    for (const block of toneIqBlocks(segments, rate, 37000, .015)) { core.receive({ ...block, generation: 7, firstSampleIndex: index }); index += block.I.length; events.push(...core.drainEvents().map(event => event.value)); }
    core.flush(); events.push(...core.drainEvents().map(event => event.value));
    const state = core.snapshot();
    expect(state.provenance).toMatchObject({ generation: 7, selectedChannelOffsetHz: 37000, actualInputSampleRateHz: rate });
    if (mode === "CW-TEXT") expect(state.value.text.trim()).toBe("SOS TEST 123");
    else {
      expect(events.some(event => event.type === "row")).toBe(true);
      expect(state.value.image?.complete).toBe(false);
      expect(state.value.image?.reason).toContain("End of input");
      expect(state.value.image!.rows).toBeGreaterThan(0);
      expect(events.filter(event => event.type === "row").every(event => event.pixels.byteLength < 8192)).toBe(true);
    }
    core.dispose();
  }
}, 30000);

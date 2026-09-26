// Run with: node --experimental-transform-types scripts/benchmark-dab.mjs
// Measures channel coding only; live UI reports OFDM/FEC frame wall time.
import console from "node:console";
import { performance } from "node:perf_hooks";
import {
  decodeDabConvolutional,
  decodeFicGroup,
} from "../src/dab/dabChannelCoding.ts";

let seed = 0x12345678;
function metrics(length) {
  return Int8Array.from({ length }, () => {
    seed ^= seed << 13;
    seed ^= seed >>> 17;
    seed ^= seed << 5;
    return (seed >>> 24) - 128;
  });
}
function measure(run) {
  for (let i = 0; i < 20; i += 1) run();
  const start = performance.now();
  for (let i = 0; i < 200; i += 1) run();
  return (performance.now() - start) / 200;
}
const fic = metrics(2304);
const ficMs = measure(() => decodeFicGroup(fic));
const rows = [32, 64, 96, 192].map((kbps) => {
  const n = kbps / 8;
  const input = metrics(n * 6 * 64);
  const segments = [
    { vector: 8, motherBits: 128 * (6 * n - 3) },
    { vector: 7, motherBits: 128 * 3 },
    { vector: 0, motherBits: 24 },
  ];
  const mscMs = measure(() => decodeDabConvolutional(input, segments));
  return {
    kbps,
    ficGroupMs: +ficMs.toFixed(3),
    msc24ms: +mscMs.toFixed(3),
    codingPer96msFrame: +(4 * (ficMs + mscMs)).toFixed(3),
  };
});
console.table(rows);

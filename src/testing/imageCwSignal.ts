export interface ToneSegment { hz: number; seconds: number; amplitude?: number; }
/** Generated wire vectors, not independently received RF. */
export function martinSegments(mode: "Martin M1" | "Martin M2" = "Martin M2", rows = 4, badParity = false): ToneSegment[] {
  const vis = mode === "Martin M1" ? 44 : 40;
  const scan = mode === "Martin M1" ? 0.146432 : 0.073216;
  const bits = Array.from({ length: 7 }, (_, n) => vis >> n & 1);
  const parity = bits.reduce((a, b) => a + b, 0) % 2;
  const segments: ToneSegment[] = [
    { hz: 1900, seconds: .3 }, { hz: 1200, seconds: .01 }, { hz: 1900, seconds: .3 }, { hz: 1200, seconds: .03 },
    ...[...bits, badParity ? 1 - parity : parity].map(bit => ({ hz: bit ? 1100 : 1300, seconds: .03 })),
    { hz: 1200, seconds: .03 },
  ];
  for (let y = 0; y < rows; y++) {
    segments.push({ hz: 1200, seconds: .004862 }, { hz: 1500, seconds: .000572 });
    // Each row contains red, green, blue, white quarter-width bars.
    for (const channel of [1, 2, 0]) {
      for (let bar = 0; bar < 4; bar++) segments.push({ hz: bar === channel || bar === 3 ? 2300 : 1500, seconds: scan / 4 });
      segments.push({ hz: 1500, seconds: .000572 });
    }
  }
  // One more sync completes the last row without implying a complete frame.
  segments.push({ hz: 1200, seconds: .01 });
  return segments;
}
export function wefaxSegments(automatic = true, rows = 4, shift = 800): ToneSegment[] {
  const black = 1900 - shift / 2, white = 1900 + shift / 2;
  const segments: ToneSegment[] = [];
  if (automatic) {
    segments.push({ hz: 300, seconds: 1.5 });
    for (let n = 0; n < 7; n++) segments.push({ hz: white, seconds: .0125 }, { hz: black, seconds: .475 }, { hz: white, seconds: .0125 });
    segments.push({ hz: white, seconds: .5 });
  }
  for (let n = 0; n < rows; n++) for (let x = 0; x < 4; x++) segments.push({ hz: black + x / 3 * shift, seconds: .125 });
  segments.push({ hz: automatic ? 450 : black, seconds: automatic ? 1.5 : .01 });
  return segments;
}
export function cwSegments(wpm = 20): ToneSegment[] {
  const unit = 1.2 / wpm;
  // Fixed SOS TEST 123 wire vector independent of the receiver's codebook.
  const words = [["...", "---", "..."], ["-", ".", "...", "-"], [".----", "..---", "...--"]];
  const segments: ToneSegment[] = [{ hz: 0, seconds: unit * 3, amplitude: 0 }];
  for (let w = 0; w < words.length; w++) for (let c = 0; c < words[w]!.length; c++) {
    for (const mark of words[w]![c]!) segments.push({ hz: 0, seconds: unit * (mark === "." ? 1 : 3) }, { hz: 0, seconds: unit, amplitude: 0 });
    segments.push({ hz: 0, seconds: unit * (c === words[w]!.length - 1 ? 6 : 2), amplitude: 0 });
  }
  return segments;
}
/** Stream raw RF without allocating a minute-long full-rate I/Q array. */
export function* toneIqBlocks(segments: readonly ToneSegment[], rate: number, offset = 37000, noise = 0): Generator<{ I: Float32Array; Q: Float32Array }> {
  let phase = .42, total = 0, emitted = 0, n = 0, randomState = 42;
  let I = new Float32Array(32749), Q = new Float32Array(32749);
  const random = () => { randomState = (Math.imul(randomState, 1664525) + 1013904223) | 0; return ((randomState >>> 0) / 4294967296 - .5) * noise; };
  for (const segment of segments) {
    total += segment.seconds * rate;
    const end = Math.round(total), rotation = 2 * Math.PI * (offset + segment.hz) / rate;
    while (emitted < end) {
      phase = (phase + rotation) % (2 * Math.PI);
      const amplitude = segment.amplitude === undefined ? .65 : segment.amplitude;
      I[n] = amplitude * Math.cos(phase) + random(); Q[n] = amplitude * Math.sin(phase) + random(); n++; emitted++;
      if (n === I.length) { yield { I, Q }; I = new Float32Array(32749); Q = new Float32Array(32749); n = 0; }
    }
  }
  if (n) yield { I: I.slice(0, n), Q: Q.slice(0, n) };
}

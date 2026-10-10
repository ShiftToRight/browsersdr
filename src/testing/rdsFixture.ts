const FIXTURE_BIT_RATE = 1_187.5;
const FIXTURE_SUBCARRIER_HZ = 57_000;
const FIXTURE_POLYNOMIAL = 0x5b9;
const FIXTURE_OFFSETS = [0x0fc, 0x198, 0x168, 0x1b4] as const;

export interface RdsFixtureOptions {
  sampleRate?: number;
  pi?: number;
  programmeService?: string;
  radioText?: string;
  radioTextAb?: 0 | 1;
  corruptGroup?: number;
  rdsAmplitude?: number;
  pilotAmplitude?: number;
  audioAmplitude?: number;
  stereoAmplitude?: number;
  carrierOffsetHz?: number;
}

/**
 * Deterministic standards-based RDS multiplex fixture. Groups use the IEC/EN
 * 62106 generator polynomial/offset words, differential coding, biphase symbols,
 * a 57 kHz suppressed carrier, a 19 kHz pilot and unrelated mono audio.
 */
export function createRdsMultiplexFixture(options: RdsFixtureOptions = {}): Float32Array {
  const sampleRate = options.sampleRate ?? 228_000;
  const pi = options.pi ?? 0xc201;
  const ps = (options.programmeService ?? "CODEX FM").padEnd(8).slice(0, 8);
  const rt = `${options.radioText ?? "BrowserSDR RDS fixture"}\r`.padEnd(64).slice(0, 64);
  const groups: number[][] = [];
  for (let pass = 0; pass < 2; pass += 1) {
    for (let segment = 0; segment < 4; segment += 1) {
      groups.push(group(pi, segment, 0, word(ps, segment * 2)));
    }
    for (let segment = 0; segment < Math.ceil(rt.indexOf("\r") / 4) + 1; segment += 1) {
      groups.push(group(pi, 0x2000 | ((options.radioTextAb ?? 0) << 4) | segment, word(rt, segment * 4), word(rt, segment * 4 + 2)));
    }
  }
  const bits: number[] = Array(24).fill(0);
  groups.forEach((blocks, groupIndex) => {
    blocks.forEach((block, blockIndex) => {
      let sent = block;
      if (groupIndex === options.corruptGroup && blockIndex === 2) sent ^= 1 << 17;
      for (let bit = 25; bit >= 0; bit -= 1) bits.push((sent >>> bit) & 1);
    });
  });
  let previous = 0;
  const chips: number[] = [];
  for (const bit of bits) {
    const encoded = bit ^ previous;
    previous = encoded;
    chips.push(encoded, encoded ^ 1);
  }
  const samplesPerChip = sampleRate / (FIXTURE_BIT_RATE * 2);
  const out = new Float32Array(Math.ceil(chips.length * samplesPerChip));
  for (let sample = 0; sample < out.length; sample += 1) {
    const chip = chips[Math.floor(sample / samplesPerChip)]! ? 1 : -1;
    const time = sample / sampleRate;
    out[sample] = (options.rdsAmplitude ?? 0.18) * chip * Math.cos(2 * Math.PI * (FIXTURE_SUBCARRIER_HZ + (options.carrierOffsetHz ?? 0)) * time)
      + (options.pilotAmplitude ?? 0.05) * Math.cos(2 * Math.PI * 19_000 * time)
      + (options.audioAmplitude ?? 0.04) * Math.sin(2 * Math.PI * 1_000 * time)
      + (options.stereoAmplitude ?? 0) * Math.cos(2 * Math.PI * 38_000 * time) * Math.sin(2 * Math.PI * 7_000 * time);
  }
  return out;
}

function group(pi: number, b: number, c: number, d: number): number[] {
  return [
    fixtureBlock(pi, FIXTURE_OFFSETS[0]),
    fixtureBlock(b, FIXTURE_OFFSETS[1]),
    fixtureBlock(c, (b & 0x0800) === 0 ? FIXTURE_OFFSETS[2] : 0x350),
    fixtureBlock(d, FIXTURE_OFFSETS[3]),
  ];
}

// Kept independent from the production checker so a shared helper cannot make
// a malformed fixture self-validating.
function fixtureBlock(data: number, offset: number): number {
  let dividend = (data & 0xffff) * 1024;
  for (let top = 25; top >= 10; top -= 1) {
    if (Math.floor(dividend / 2 ** top) % 2 === 1) dividend ^= FIXTURE_POLYNOMIAL * 2 ** (top - 10);
  }
  return (data & 0xffff) * 1024 + ((dividend & 0x3ff) ^ offset);
}

function word(text: string, offset: number): number {
  return ((text.charCodeAt(offset) || 0x20) << 8) | (text.charCodeAt(offset + 1) || 0x20);
}

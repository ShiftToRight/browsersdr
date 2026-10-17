import { decodeDabText } from "./dabText";

/**
 * DAB channel coding primitives and the minimal FIC database needed to select a
 * DAB+ stream service. Constants and processing order follow ETSI EN 300 401.
 * The puncturing/EEP tables are adapted from William Yang's MIT-licensed
 * DAB-Radio project; see THIRD_PARTY_NOTICES.md.
 */

export interface DabSubchannel {
  id: number;
  startAddress: number;
  length: number;
  eepType: "A" | "B";
  protectionLevel: number;
}

export interface DabAudioService {
  serviceId: number;
  subchannelId: number;
  primary: boolean;
  dabPlus: boolean;
}

export interface DabStation extends DabAudioService {
  key: string;
  label?: string;
  shortLabel?: string;
  bitrateKbps?: number;
  protection?: string;
  playable: boolean;
}

export interface DabLabel {
  label: string;
  shortLabel: string;
}

export function dabSubchannelBitrate(subchannel: DabSubchannel): number {
  const multiples =
    subchannel.eepType === "A" ? [12, 8, 6, 4] : [27, 21, 18, 15];
  return (
    (subchannel.length / multiples[subchannel.protectionLevel]!) *
    (subchannel.eepType === "A" ? 8 : 32)
  );
}

const POLYNOMIALS = [109, 79, 83, 109] as const;
const PUNCTURE_COUNTS: readonly (readonly number[])[] = [
  [2, 1, 1, 1, 1, 1, 1, 1],
  [2, 1, 1, 1, 2, 1, 1, 1],
  [2, 1, 2, 1, 2, 1, 1, 1],
  [2, 1, 2, 1, 2, 1, 2, 1],
  [2, 2, 2, 1, 2, 1, 2, 1],
  [2, 2, 2, 1, 2, 2, 2, 1],
  [2, 2, 2, 2, 2, 2, 2, 1],
  [2, 2, 2, 2, 2, 2, 2, 2],
  [3, 2, 2, 2, 2, 2, 2, 2],
  [3, 2, 2, 2, 3, 2, 2, 2],
  [3, 2, 3, 2, 3, 2, 2, 2],
  [3, 2, 3, 2, 3, 2, 3, 2],
  [3, 3, 3, 2, 3, 2, 3, 2],
  [3, 3, 3, 2, 3, 3, 3, 2],
  [3, 3, 3, 3, 3, 3, 3, 2],
  [3, 3, 3, 3, 3, 3, 3, 3],
  [4, 3, 3, 3, 3, 3, 3, 3],
  [4, 3, 3, 3, 4, 3, 3, 3],
  [4, 3, 4, 3, 4, 3, 3, 3],
  [4, 3, 4, 3, 4, 3, 4, 3],
  [4, 4, 4, 3, 4, 3, 4, 3],
  [4, 4, 4, 3, 4, 4, 4, 3],
  [4, 4, 4, 4, 4, 4, 4, 3],
  [4, 4, 4, 4, 4, 4, 4, 4],
];
const TAIL_COUNTS = [2, 2, 2, 2, 2, 2] as const;

interface PunctureSegment {
  vector: number;
  motherBits: number;
}

function parity(value: number): number {
  value ^= value >>> 4;
  value ^= value >>> 2;
  value ^= value >>> 1;
  return value & 1;
}

function depuncture(
  input: Int8Array | Float32Array,
  segments: readonly PunctureSegment[],
): Float32Array | undefined {
  const total = segments.reduce((sum, item) => sum + item.motherBits, 0);
  const output = new Float32Array(total);
  let source = 0,
    target = 0;
  for (const segment of segments) {
    const counts =
      segment.vector === 0 ? TAIL_COUNTS : PUNCTURE_COUNTS[segment.vector - 1];
    if (!counts || segment.motherBits % 4 !== 0) return undefined;
    for (let group = 0; group < segment.motherBits / 4; group += 1) {
      const transmitted = counts[group % counts.length]!;
      if (source + transmitted > input.length) return undefined;
      for (let bit = 0; bit < transmitted; bit += 1)
        output[target + bit] = input[source++]!;
      target += 4;
    }
  }
  return source === input.length ? output : undefined;
}

// Each K=7 transition emits one of sixteen four-bit codewords. Compute
// parity once, then share its branch metric across all trellis states.
const TRANSITION_CODES = Uint8Array.from({ length: 128 }, (_, register) =>
  POLYNOMIALS.reduce(
    (code, polynomial, bit) => code | (parity(register & polynomial) << bit),
    0,
  ),
);

/** Soft-decision, terminated K=7 rate-1/4 DAB Viterbi decoder. */
export function decodeDabConvolutional(
  punctured: Int8Array | Float32Array,
  segments: readonly PunctureSegment[],
): Uint8Array | undefined {
  const symbols = depuncture(punctured, segments);
  if (!symbols) return undefined;
  const steps = symbols.length / 4;
  if (steps < 7) return undefined;
  const decisions = new Uint8Array(steps * 64);
  let previous = new Float64Array(64).fill(Number.NEGATIVE_INFINITY);
  let next = new Float64Array(64);
  const metrics = new Float64Array(16);
  previous[0] = 0;
  for (let step = 0; step < steps; step += 1) {
    const offset = step * 4;
    const a = symbols[offset]!,
      b = symbols[offset + 1]!,
      c = symbols[offset + 2]!,
      d = symbols[offset + 3]!;
    for (let code = 0; code < 16; code += 1)
      metrics[code] =
        (code & 1 ? a : -a) +
        (code & 2 ? b : -b) +
        (code & 4 ? c : -c) +
        (code & 8 ? d : -d);
    // All four generators have both end taps set. The two input bits and
    // the two predecessor halves therefore emit complementary codewords:
    // one branch metric serves an entire two-state butterfly.
    for (let low = 0; low < 32; low += 1) {
      const high = low + 32,
        even = low * 2,
        odd = even + 1;
      const metric = metrics[TRANSITION_CODES[even]!]!;
      const a0 = previous[low]! + metric,
        b0 = previous[high]! - metric;
      const a1 = previous[low]! - metric,
        b1 = previous[high]! + metric;
      const high0 = b0 > a0,
        high1 = b1 > a1;
      next[even] = high0 ? b0 : a0;
      next[odd] = high1 ? b1 : a1;
      decisions[step * 64 + even] = high0 ? high : low;
      decisions[step * 64 + odd] = high1 ? high : low;
    }
    [previous, next] = [next, previous];
  }
  const dataBits = steps - 6;
  const output = new Uint8Array(Math.floor(dataBits / 8));
  let state = 0;
  for (let step = steps - 1; step >= 0; step -= 1) {
    if (step < dataBits && (state & 1) !== 0)
      output[step >> 3] = output[step >> 3]! | (1 << (7 - (step & 7)));
    state = decisions[step * 64 + state]!;
  }
  return output;
}

export function dabDescramble(bytes: Uint8Array): Uint8Array {
  const output = bytes.slice();
  let register = 0xffff;
  for (let index = 0; index < output.length; index += 1) {
    let mask = 0;
    for (let bit = 0; bit < 8; bit += 1) {
      const value = ((register >> 8) ^ (register >> 4)) & 1;
      mask |= value << (7 - bit);
      register = ((register << 1) | value) & 0xffff;
    }
    output[index] = output[index]! ^ mask;
  }
  return output;
}

export function dabCrc16(bytes: Uint8Array): number {
  let crc = 0xffff;
  for (const byte of bytes) {
    crc ^= byte << 8;
    for (let bit = 0; bit < 8; bit += 1)
      crc = ((crc << 1) ^ (crc & 0x8000 ? 0x1021 : 0)) & 0xffff;
  }
  return crc ^ 0xffff;
}

export function decodeFicGroup(encoded: Int8Array): Uint8Array[] {
  if (encoded.length !== 2304) return [];
  const decoded = decodeDabConvolutional(encoded, [
    { vector: 16, motherBits: 128 * 21 },
    { vector: 15, motherBits: 128 * 3 },
    { vector: 0, motherBits: 24 },
  ]);
  if (!decoded || decoded.length !== 96) return [];
  const bytes = dabDescramble(decoded);
  const fibs: Uint8Array[] = [];
  for (let offset = 0; offset < bytes.length; offset += 32) {
    const fib = bytes.subarray(offset, offset + 32);
    const stored = (fib[30]! << 8) | fib[31]!;
    if (dabCrc16(fib.subarray(0, 30)) === stored) fibs.push(fib.slice(0, 30));
  }
  return fibs;
}

/** Persistent subset of the FIC database: FIG 0/1 and FIG 0/2. */
export class DabFicDatabase {
  ensemble?: DabLabel & { id: number };
  readonly labels = new Map<number, DabLabel>();
  readonly subchannels = new Map<number, DabSubchannel>();
  readonly services = new Map<string, DabAudioService>();

  processFib(fib: Uint8Array): void {
    for (let offset = 0; offset < fib.length;) {
      const header = fib[offset++]!;
      if (header === 0xff) return;
      const type = header >> 5,
        length = header & 0x1f;
      if (offset + length > fib.length) return;
      const body = fib.subarray(offset, offset + length);
      offset += length;
      if (type === 1) {
        this.processLabel(body);
        continue;
      }
      if (type !== 0 || body.length < 1) continue;
      const descriptor = body[0]!,
        extension = descriptor & 0x1f,
        pd = (descriptor & 0x20) !== 0;
      // CN/OE describe a future configuration or another ensemble; neither
      // may overwrite the currently received MSC layout.
      if (descriptor & 0xc0) continue;
      if (extension === 1) this.processSubchannels(body.subarray(1));
      else if (extension === 2)
        this.processServices(body.subarray(1), pd ? 4 : 2);
    }
  }

  stations(): DabStation[] {
    return [...this.services.entries()]
      .map(([key, service]) => {
        const subchannel = this.subchannels.get(service.subchannelId);
        return {
          ...service,
          key,
          ...this.labels.get(service.serviceId),
          bitrateKbps: subchannel
            ? dabSubchannelBitrate(subchannel)
            : undefined,
          protection: subchannel ? `EEP ${subchannel.protectionLevel + 1}-${subchannel.eepType}` : undefined,
          playable: service.dabPlus && subchannel !== undefined,
        };
      })
      .sort(
        (a, b) => a.serviceId - b.serviceId || a.subchannelId - b.subchannelId,
      );
  }

  private processLabel(body: Uint8Array): void {
    if (!body.length || body[0]! & 8) return; // Other ensemble.
    const extension = body[0]! & 7,
      charset = body[0]! >> 4;
    if (extension !== 0 && extension !== 1 && extension !== 5) return;
    const idBytes = extension === 5 ? 4 : 2;
    if (body.length !== 1 + idBytes + 18) return;
    let id = 0;
    for (let i = 1; i <= idBytes; i++) id = id * 256 + body[i]!;
    const bytes = body.subarray(1 + idBytes, 17 + idBytes);
    const label = decodeDabText(bytes, charset, false);
    if (label === undefined) return;
    const mask = body[17 + idBytes]! * 256 + body[18 + idBytes]!;
    // The mask addresses characters, not bytes, including multibyte labels.
    const shortLabel = Array.from(label)
      .filter((_, i) => mask & (0x8000 >> i))
      .join("")
      .trim();
    const value = { label: label.trim(), shortLabel };
    if (extension === 0) this.ensemble = { id, ...value };
    else this.labels.set(id, value);
  }

  selectedDabPlusService(key?: string):
    | {
        service: DabAudioService;
        subchannel: DabSubchannel;
      }
    | undefined {
    const candidates = [...this.services.values()]
      .filter(
        (service) =>
          service.dabPlus &&
          (key === undefined ||
            key === `${service.serviceId}:${service.subchannelId}`),
      )
      .sort((left, right) => Number(right.primary) - Number(left.primary));
    for (const service of candidates) {
      const subchannel = this.subchannels.get(service.subchannelId);
      if (subchannel) return { service, subchannel };
    }
    return undefined;
  }

  reset(): void {
    this.ensemble = undefined;
    this.labels.clear();
    this.subchannels.clear();
    this.services.clear();
  }

  private processSubchannels(body: Uint8Array): void {
    for (let offset = 0; offset + 3 <= body.length;) {
      const id = body[offset]! >> 2;
      const startAddress = ((body[offset]! & 3) << 8) | body[offset + 1]!;
      const long = (body[offset + 2]! & 0x80) !== 0;
      if (!long) {
        offset += 3; // UEP is used by legacy DAB audio, not DAB+.
        continue;
      }
      if (offset + 4 > body.length) return;
      const option = (body[offset + 2]! >> 4) & 7;
      if (option > 1) {
        offset += 4;
        continue;
      }
      this.subchannels.set(id, {
        id,
        startAddress,
        length: ((body[offset + 2]! & 3) << 8) | body[offset + 3]!,
        eepType: option === 0 ? "A" : "B",
        protectionLevel: (body[offset + 2]! >> 2) & 3,
      });
      offset += 4;
    }
  }

  private processServices(body: Uint8Array, idBytes: number): void {
    for (let offset = 0; offset + idBytes + 1 <= body.length;) {
      let serviceId = 0;
      for (let index = 0; index < idBytes; index += 1)
        serviceId = serviceId * 256 + body[offset + index]!;
      const componentCount = body[offset + idBytes]! & 15;
      offset += idBytes + 1;
      if (offset + componentCount * 2 > body.length) return;
      for (let index = 0; index < componentCount; index += 1) {
        const first = body[offset]!,
          second = body[offset + 1]!;
        offset += 2;
        if (first >> 6 !== 0) continue;
        const audioType = first & 0x3f,
          subchannelId = second >> 2,
          primary = (second & 2) !== 0,
          conditionalAccess = (second & 1) !== 0;
        if (conditionalAccess || (audioType !== 0 && audioType !== 63))
          continue;
        this.services.set(`${serviceId}:${subchannelId}`, {
          serviceId,
          subchannelId,
          primary,
          dabPlus: audioType === 63,
        });
      }
    }
  }
}

interface EepDescriptor {
  multiple: number;
  bitrateMultiple: number;
  first: readonly [number, number];
  second: readonly [number, number];
}
const EEP_A: readonly EepDescriptor[] = [
  { multiple: 12, bitrateMultiple: 8, first: [6, -3], second: [0, 3] },
  { multiple: 8, bitrateMultiple: 8, first: [2, -3], second: [4, 3] },
  { multiple: 6, bitrateMultiple: 8, first: [6, -3], second: [0, 3] },
  { multiple: 4, bitrateMultiple: 8, first: [4, -3], second: [2, 3] },
];
const EEP_B: readonly EepDescriptor[] = [
  { multiple: 27, bitrateMultiple: 32, first: [24, -3], second: [0, 3] },
  { multiple: 21, bitrateMultiple: 32, first: [24, -3], second: [0, 3] },
  { multiple: 18, bitrateMultiple: 32, first: [24, -3], second: [0, 3] },
  { multiple: 15, bitrateMultiple: 32, first: [24, -3], second: [0, 3] },
];
const EEP_2A_SPECIAL: EepDescriptor = {
  multiple: 8,
  bitrateMultiple: 8,
  first: [0, 5],
  second: [0, 1],
};

function eepDescriptor(subchannel: DabSubchannel): EepDescriptor | undefined {
  if (
    subchannel.eepType === "A" &&
    subchannel.protectionLevel === 1 &&
    subchannel.length === 8
  )
    return EEP_2A_SPECIAL;
  return (subchannel.eepType === "A" ? EEP_A : EEP_B)[
    subchannel.protectionLevel
  ];
}

const TIME_OFFSETS = [0, 8, 4, 12, 2, 10, 6, 14, 1, 9, 5, 13, 3, 11, 7, 15];

export class DabMscSubchannelDecoder {
  private readonly history: Int8Array[] = [];
  constructor(readonly subchannel: DabSubchannel) {}

  pushCif(cif: Int8Array): Uint8Array | undefined {
    const start = this.subchannel.startAddress * 64,
      length = this.subchannel.length * 64;
    if (start + length > cif.length) return undefined;
    this.history.push(cif.slice(start, start + length));
    if (this.history.length > 16) this.history.shift();
    if (this.history.length < 16) return undefined;
    const deinterleaved = new Int8Array(length);
    for (let bit = 0; bit < length; bit += 1)
      deinterleaved[bit] = this.history[TIME_OFFSETS[bit & 15]!]![bit]!;
    return this.decode(deinterleaved);
  }

  reset(): void {
    this.history.length = 0;
  }

  private decode(encoded: Int8Array): Uint8Array | undefined {
    const descriptor = eepDescriptor(this.subchannel);
    if (!descriptor || this.subchannel.length % descriptor.multiple !== 0)
      return undefined;
    const n = this.subchannel.length / descriptor.multiple;
    const firstBlocks = descriptor.first[0] * n + descriptor.first[1];
    const secondBlocks = descriptor.second[0] * n + descriptor.second[1];
    if (firstBlocks < 0 || secondBlocks < 0) return undefined;
    const firstVector =
      this.subchannel.eepType === "A"
        ? this.subchannel.protectionLevel === 1 && this.subchannel.length === 8
          ? 13
          : [24, 14, 8, 3][this.subchannel.protectionLevel]!
        : [10, 6, 4, 2][this.subchannel.protectionLevel]!;
    const secondVector =
      this.subchannel.eepType === "A"
        ? this.subchannel.protectionLevel === 1 && this.subchannel.length === 8
          ? 12
          : [23, 13, 7, 2][this.subchannel.protectionLevel]!
        : [9, 5, 3, 1][this.subchannel.protectionLevel]!;
    const decoded = decodeDabConvolutional(encoded, [
      { vector: firstVector, motherBits: 128 * firstBlocks },
      { vector: secondVector, motherBits: 128 * secondBlocks },
      { vector: 0, motherBits: 24 },
    ]);
    if (!decoded) return undefined;
    const expectedBytes = n * descriptor.bitrateMultiple * 3;
    return decoded.length === expectedBytes
      ? dabDescramble(decoded)
      : undefined;
  }
}

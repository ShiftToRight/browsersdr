import { dabCrc16 } from "./dabChannelCoding";
import { decodeDabText } from "./dabText";
import { DabMotDecoder, type DabSlideshow } from "./dabMot";

export interface DabProgrammeMetadata {
  text?: string;
  slide?: DabSlideshow;
}

export function validDabDataCrc(bytes: Uint8Array): boolean {
  return (
    bytes.length >= 2 &&
    dabCrc16(bytes.subarray(0, -2)) ===
      bytes[bytes.length - 2]! * 256 + bytes[bytes.length - 1]!
  );
}

/** Extract only the leading AAC data_stream_element; leave AAC bytes unchanged. */
export function extractDabPad(au: Uint8Array): Uint8Array | undefined {
  if (au.length < 2 || au[0]! >> 5 !== 4) return undefined;
  let offset = 2,
    length = au[1]!;
  if (length === 255) {
    if (au.length < 3) return undefined;
    length += au[offset++]!;
  }
  // DSE header is already byte-aligned, including when byte_align_flag is 0.
  if (length < 2 || length > 198 || offset + length > au.length)
    return undefined;
  return au.subarray(offset, offset + length);
}

const LENGTHS = [4, 6, 8, 12, 16, 24, 32, 48];
const continuation = (type: number) =>
  type === 2 ? 3 : type === 12 ? 13 : type;

/** Bounded X-PAD demultiplexer and CRC-checked Dynamic Label reassembly.
 * ETSI EN 300 401 §7.4; AAC encapsulation: TS 102 563 §5.4.
 * See THIRD_PARTY_NOTICES.md for the MIT reference consulted.
 */
export class DabPadDecoder {
  private padUnits = 0;
  private labelGroups = 0;
  get diagnostics() {
    return {
      padUnits: this.padUnits,
      labelGroups: this.labelGroups,
      ...this.mot.diagnostics,
    };
  }
  private previousType?: number;
  private previousLength = 0;
  private dl?: number[];
  private dgli: number[] = [];
  private motGroup?: { length: number; bytes: number[] };
  private nextMotLength?: number;
  private toggle?: number;
  private charset?: number;
  private lastSegment?: number;
  private segments = new Map<number, Uint8Array>();
  private metadata: DabProgrammeMetadata = {};
  private readonly mot: DabMotDecoder;

  constructor(
    private readonly onUpdate: (metadata: DabProgrammeMetadata) => void,
    now: () => number = Date.now,
  ) {
    this.mot = new DabMotDecoder((slide) => {
      this.metadata = { ...this.metadata, slide };
      this.onUpdate(this.metadata);
    }, now);
  }

  reset(): void {
    this.discontinuity();
    this.padUnits = this.labelGroups = 0;
    this.mot.reset();
    this.metadata = {};
    this.onUpdate(this.metadata);
  }

  discontinuity(): void {
    this.previousType = undefined;
    this.previousLength = 0;
    this.dl = undefined;
    this.dgli = [];
    this.motGroup = undefined;
    this.nextMotLength = undefined;
    this.segments.clear();
    this.toggle = this.charset = this.lastSegment = undefined;
  }

  processAccessUnit(au: Uint8Array): void {
    this.mot.tick();
    const pad = extractDabPad(au);
    if (!pad) {
      this.previousType = undefined;
      return;
    }
    this.padUnits++;
    this.processPad(pad);
  }

  processPad(pad: Uint8Array): void {
    if (pad.length < 2 || pad.length > 198) {
      this.discontinuity();
      return;
    }
    const f0 = pad[pad.length - 2]!,
      f1 = pad[pad.length - 1]!;
    const indicator = (f0 >> 4) & 3,
      hasCi = !!(f1 & 2);
    if (f0 & 0xc0 || indicator === 3) {
      this.discontinuity();
      return;
    }
    if (indicator === 0) {
      this.previousType = undefined;
      return;
    }
    const xpad = pad.slice(0, -2).reverse();
    if ((indicator === 1 && xpad.length !== 4) || !xpad.length) {
      this.discontinuity();
      return;
    }
    const entries: { type: number; length: number }[] = [];
    let offset = 0;
    if (hasCi) {
      for (let i = 0; i < (indicator === 1 ? 1 : 4); i++) {
        if (offset >= xpad.length) {
          this.discontinuity();
          return;
        }
        const ci = xpad[offset++]!,
          type = ci & 31;
        if (!type) break;
        entries.push({ type, length: indicator === 1 ? 3 : LENGTHS[ci >> 5]! });
      }
    } else {
      // A CI-free variable field continues the *last* previous sub-field,
      // using the whole field (not the previous list of CI lengths).
      if (
        this.previousType === undefined ||
        (indicator === 2 && xpad.length !== this.previousLength)
      )
        return;
      entries.push({ type: this.previousType, length: xpad.length });
    }
    if (
      offset + entries.reduce((sum, entry) => sum + entry.length, 0) >
      xpad.length
    ) {
      this.discontinuity();
      return;
    }
    this.previousType = undefined;
    for (const entry of entries) {
      const data = xpad.subarray(offset, offset + entry.length);
      offset += entry.length;
      this.processSubfield(entry.type, data);
      this.previousType = continuation(entry.type);
    }
    this.previousLength = xpad.length;
  }

  private processSubfield(type: number, data: Uint8Array): void {
    const motLength = this.nextMotLength;
    this.nextMotLength = undefined;
    if (type !== 1) this.dgli = [];
    if (type === 1) {
      this.dgli.push(...data.subarray(0, 4 - this.dgli.length));
      if (this.dgli.length === 4) {
        const bytes = Uint8Array.from(this.dgli);
        if (validDabDataCrc(bytes))
          this.nextMotLength = ((bytes[0]! & 63) << 8) | bytes[1]!;
        this.dgli = [];
      }
    } else if (type === 2 || type === 3) {
      if (type === 2) this.dl = [];
      if (!this.dl) return;
      this.dl.push(...data.subarray(0, 20 - this.dl.length));
      if (this.dl.length < 2) return;
      // Commands other than clear (including DL+) are not text segments.
      const command = !!(this.dl[0]! & 16);
      if (command && (this.dl[0]! & 15) !== 1) {
        this.dl = undefined;
        return;
      }
      const length = command ? 4 : 5 + (this.dl[0]! & 15);
      if (this.dl.length < length) return;
      const group = Uint8Array.from(this.dl.slice(0, length));
      this.dl = undefined;
      if (validDabDataCrc(group)) this.processLabel(group);
    } else if (type === 12 || type === 13) {
      if (type === 12)
        this.motGroup =
          motLength && motLength >= 11 && motLength <= 16_383
            ? { length: motLength, bytes: [] }
            : undefined;
      const group = this.motGroup;
      if (!group) return;
      group.bytes.push(...data.subarray(0, group.length - group.bytes.length));
      if (group.bytes.length === group.length) {
        this.motGroup = undefined;
        this.mot.processGroup(Uint8Array.from(group.bytes));
      }
    }
  }

  private processLabel(group: Uint8Array): void {
    this.labelGroups++;
    const flags = group[0]!;
    if (flags & 16) {
      this.segments.clear();
      this.charset = this.lastSegment = this.toggle = undefined;
      this.publishText("");
      return;
    }
    const toggle = flags >> 7,
      first = !!(flags & 64),
      last = !!(flags & 32);
    const index = first ? 0 : (group[1]! >> 4) & 7;
    if (toggle !== this.toggle) {
      this.segments.clear();
      this.charset = this.lastSegment = undefined;
      this.toggle = toggle;
    }
    const bytes = group.slice(2, -2),
      previous = this.segments.get(index);
    if (
      previous &&
      (previous.length !== bytes.length ||
        previous.some((value, i) => value !== bytes[i]))
    ) {
      this.segments.clear();
      this.charset = this.lastSegment = undefined;
    }
    if (first) this.charset = group[1]! >> 4;
    if (last) this.lastSegment = index;
    this.segments.set(index, bytes);
    if (this.charset === undefined || this.lastSegment === undefined) return;
    const parts: number[] = [];
    for (let i = 0; i <= this.lastSegment; i++) {
      const segment = this.segments.get(i);
      if (!segment) return;
      parts.push(...segment);
    }
    const text = decodeDabText(Uint8Array.from(parts), this.charset);
    if (text !== undefined) this.publishText(text);
  }

  private publishText(text: string): void {
    if (text === this.metadata.text) return;
    this.metadata = { ...this.metadata, text };
    this.onUpdate(this.metadata);
  }
}

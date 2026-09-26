import { dabCrc16 } from "./dabChannelCoding";
import { decodeDabText } from "./dabText";

export interface DabSlideshow {
  transportId: number;
  name: string;
  category?: string;
  mimeType: "image/jpeg" | "image/png";
  data: Uint8Array<ArrayBuffer>;
}
interface Parts {
  segments: Map<number, Uint8Array>;
  last?: number;
  size: number;
}
interface Header {
  size: number;
  type: number;
  subtype: number;
  name: string;
  category?: string;
  trigger?: number | "now";
  expires?: number;
}
interface ObjectState {
  headerParts: Parts;
  bodyParts: Parts;
  header?: Header;
  body?: Uint8Array<ArrayBuffer>;
  touched: number;
  completed: boolean;
  presented: boolean;
  trigger?: number | "now";
}
const MAX_IMAGE = 512 * 1024;
const MAX_OBJECTS = 8;
const MAX_SEGMENTS = 2048;
const emptyParts = (): Parts => ({ segments: new Map(), size: 0 });

function timeParameter(data: Uint8Array): number | "now" | undefined {
  if (data.length !== 4 && data.length !== 6) return undefined;
  if (!(data[0]! & 128)) return "now";
  const mjd = ((data[0]! & 127) << 10) | (data[1]! << 2) | (data[2]! >> 6);
  const long = !!(data[2]! & 8);
  if (long !== (data.length === 6)) return undefined;
  const hour = ((data[2]! & 7) << 2) | (data[3]! >> 6),
    minute = data[3]! & 63;
  const second = long ? data[4]! >> 2 : 0;
  if (hour > 23 || minute > 59 || second > 59) return undefined;
  return (mjd - 40587) * 86400000 + (hour * 3600 + minute * 60 + second) * 1000;
}

// MOT ContentName uses its own table (TS 101 756 table 19), including
// ISO Latin-1 at code 4; this is not the FIG/Dynamic Label charset table.
function contentName(bytes: Uint8Array): string {
  if (!bytes.length) return "";
  const charset = bytes[0]! >> 4;
  if (charset === 4)
    return Array.from(bytes.subarray(1), (byte) =>
      byte < 32 || (byte >= 127 && byte < 160)
        ? " "
        : String.fromCharCode(byte),
    )
      .join("")
      .trim();
  return charset === 0 || charset === 15
    ? (decodeDabText(bytes.subarray(1), charset) ?? "")
    : "";
}

function parseHeader(data: Uint8Array): Header | undefined {
  if (data.length < 7) return undefined;
  const size =
    data[0]! * 1048576 + data[1]! * 4096 + data[2]! * 16 + (data[3]! >> 4);
  const headerSize = ((data[3]! & 15) << 9) | (data[4]! << 1) | (data[5]! >> 7);
  if (headerSize !== data.length || size > MAX_IMAGE) return undefined;
  const header: Header = {
    size,
    type: (data[5]! >> 1) & 63,
    subtype: ((data[5]! & 1) << 8) | data[6]!,
    name: "",
  };
  for (let offset = 7; offset < data.length;) {
    const descriptor = data[offset++]!,
      pli = descriptor >> 6,
      id = descriptor & 63;
    let length = [0, 1, 4, 0][pli]!;
    if (pli === 3) {
      if (offset >= data.length) return undefined;
      const first = data[offset++]!;
      length = first & 127;
      if (first & 128) {
        if (offset >= data.length) return undefined;
        length = length * 256 + data[offset++]!;
      }
    }
    if (offset + length > data.length) return undefined;
    const value = data.subarray(offset, offset + length);
    offset += length;
    if (id === 12 && value.length) header.name = contentName(value);
    if (id === 5) {
      header.trigger = timeParameter(value);
      if (header.trigger === undefined) return undefined;
    }
    if (id === 4) {
      const expiry = timeParameter(value);
      if (expiry === undefined) return undefined;
      if (typeof expiry === "number") header.expires = expiry;
    }
    if (id === 0x26) header.category = decodeDabText(value, 15);
    // Compressed or encrypted objects cannot be decoded as plain images.
    if (id === 0x11 || id === 0x23) return undefined;
  }
  return header.name ? header : undefined;
}

function assemble(parts: Parts): Uint8Array<ArrayBuffer> | undefined {
  if (parts.last === undefined || parts.segments.size !== parts.last + 1)
    return undefined;
  const bytes = new Uint8Array(parts.size);
  let offset = 0;
  for (let i = 0; i <= parts.last; i++) {
    const segment = parts.segments.get(i);
    if (!segment) return undefined;
    bytes.set(segment, offset);
    offset += segment.length;
  }
  return bytes;
}

/** Check signatures and dimensions before allowing browser image decoding. */
export function validDabImage(data: Uint8Array, subtype: number): boolean {
  let width = 0,
    height = 0;
  if (subtype === 3) {
    if (
      data.length < 33 ||
      ![137, 80, 78, 71, 13, 10, 26, 10].every((v, i) => data[i] === v) ||
      data[12] !== 73 ||
      data[13] !== 72 ||
      data[14] !== 68 ||
      data[15] !== 82
    )
      return false;
    const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
    width = view.getUint32(16);
    height = view.getUint32(20);
  } else if (subtype === 1) {
    if (data[0] !== 255 || data[1] !== 216) return false;
    for (let offset = 2; offset + 4 <= data.length;) {
      if (data[offset++] !== 255) return false;
      while (data[offset] === 255) offset++;
      const marker = data[offset++]!;
      if (marker === 0xda || marker === 0xd9) break;
      const length = data[offset]! * 256 + data[offset + 1]!;
      if (length < 2 || offset + length > data.length) return false;
      if ([0xc0, 0xc1, 0xc2].includes(marker) && length >= 8) {
        height = data[offset + 3]! * 256 + data[offset + 4]!;
        width = data[offset + 5]! * 256 + data[offset + 6]!;
        break;
      }
      offset += length;
    }
  }
  return (
    width > 0 &&
    height > 0 &&
    width <= 4096 &&
    height <= 4096 &&
    width * height <= 4_194_304
  );
}

/** MOT header-mode slideshow transport (EN 301 234, TS 101 499).
 * Bounded out-of-order reassembly; updates use ContentName, transport uses ID.
 */
export class DabMotDecoder {
  private readonly objects = new Map<number, ObjectState>();
  private currentId?: number;
  private validGroups = 0;
  private completedObjects = 0;
  get diagnostics() {
    return {
      motGroups: this.validGroups,
      motObjects: this.completedObjects,
      motBytes: [...this.objects.values()].reduce(
        (sum, item) => sum + item.bodyParts.size,
        0,
      ),
    };
  }
  constructor(
    private readonly onSlide: (slide: DabSlideshow | undefined) => void,
    private readonly now: () => number = Date.now,
  ) {}

  reset(): void {
    this.objects.clear();
    this.validGroups = this.completedObjects = 0;
    this.currentId = undefined;
  }

  tick(): void {
    const now = this.now();
    for (const [id, object] of this.objects) {
      if (
        (object.header?.expires !== undefined &&
          object.header.expires <= now) ||
        (!object.completed && now - object.touched > 120_000)
      ) {
        this.objects.delete(id);
        if (this.currentId === id) {
          this.currentId = undefined;
          this.onSlide(undefined);
        }
      } else if (
        object.completed &&
        !object.presented &&
        typeof object.trigger === "number" &&
        object.trigger <= now
      ) {
        this.present(id, object);
      }
    }
  }

  processGroup(group: Uint8Array): void {
    this.tick();
    if (group.length < 11) return;
    const flags = group[0]!,
      type = flags & 15;
    // MOT header/body need segment number, transport ID and protected group.
    if ((flags & 0x70) !== 0x70 || (type !== 3 && type !== 4)) return;
    if (
      dabCrc16(group.subarray(0, -2)) !==
      group[group.length - 2]! * 256 + group[group.length - 1]!
    )
      return;
    const end = group.length - 2;
    let offset = flags & 128 ? 4 : 2;
    if (offset + 3 > end) return;
    const last = !!(group[offset]! & 128),
      index = ((group[offset]! & 127) << 8) | group[offset + 1]!;
    offset += 2;
    const access = group[offset++]!,
      accessLength = access & 15;
    if (
      !(access & 16) ||
      accessLength < 2 ||
      offset + accessLength + 2 > end ||
      index >= MAX_SEGMENTS
    )
      return;
    const id = group[offset]! * 256 + group[offset + 1]!;
    offset += accessLength;
    const size = ((group[offset]! & 31) << 8) | group[offset + 1]!;
    offset += 2;
    if (!size || offset + size !== end) return;
    this.validGroups++;
    let object = this.objects.get(id);
    if (!object) {
      if (this.objects.size >= MAX_OBJECTS) {
        // Prefer evicting the oldest object that isn't currently on screen.
        const oldest = [...this.objects.entries()]
          .filter(([key]) => key !== this.currentId)
          .sort((a, b) => a[1].touched - b[1].touched)[0];
        if (oldest) this.objects.delete(oldest[0]);
      }
      object = {
        headerParts: emptyParts(),
        bodyParts: emptyParts(),
        touched: this.now(),
        completed: false,
        presented: false,
      };
      this.objects.set(id, object);
    }
    object.touched = this.now();
    if (object.completed) return; // Broadcast repetitions do not retrigger slides.
    const parts = type === 3 ? object.headerParts : object.bodyParts;
    const data = group.subarray(offset, end),
      previous = parts.segments.get(index);
    if (
      previous &&
      (previous.length !== size || previous.some((v, i) => v !== data[i]))
    ) {
      this.objects.delete(id);
      return;
    }
    if (
      parts.last !== undefined &&
      (index > parts.last || (last && parts.last !== index))
    ) {
      this.objects.delete(id);
      return;
    }
    if (last) parts.last = index;
    if (!previous) {
      if (parts.size + size > (type === 3 ? 8191 : MAX_IMAGE)) {
        this.objects.delete(id);
        return;
      }
      parts.segments.set(index, data.slice());
      parts.size += size;
    }
    const complete = assemble(parts);
    if (complete) {
      if (type === 3) {
        object.header = parseHeader(complete);
        if (!object.header) {
          this.objects.delete(id);
          return;
        }
      } else object.body = complete;
    }
    const header = object.header;
    if (!header) return;
    if (header.type === 5 && header.subtype === 0 && header.size === 0) {
      object.completed = true;
      for (const [targetId, target] of this.objects) {
        if (
          targetId !== id &&
          target.header?.name === header.name &&
          target.body
        ) {
          this.setTrigger(targetId, target, header.trigger);
        }
      }
      return;
    }
    if (header.type !== 2 || (header.subtype !== 1 && header.subtype !== 3)) {
      this.objects.delete(id);
      return;
    }
    if (!object.body) return;
    if (
      object.body.length !== header.size ||
      !validDabImage(object.body, header.subtype)
    ) {
      this.objects.delete(id);
      return;
    }
    object.completed = true;
    this.completedObjects++;
    object.headerParts = emptyParts();
    object.bodyParts = emptyParts();
    this.setTrigger(id, object, header.trigger);
  }

  private setTrigger(
    id: number,
    object: ObjectState,
    trigger: Header["trigger"],
  ): void {
    object.trigger = trigger;
    object.presented = false;
    // A late scheduled slide is held for an update, per TS 101 499 §5.3.2.
    if (typeof trigger === "number" && trigger < this.now() - 1000)
      object.trigger = undefined;
    if (
      trigger === "now" ||
      (typeof object.trigger === "number" && object.trigger <= this.now())
    )
      this.present(id, object);
  }

  private present(id: number, object: ObjectState): void {
    const header = object.header!;
    if (
      !object.body ||
      (header.expires !== undefined && header.expires <= this.now())
    )
      return;
    object.presented = true;
    this.currentId = id;
    this.onSlide({
      transportId: id,
      name: header.name,
      category: header.category,
      mimeType: header.subtype === 3 ? "image/png" : "image/jpeg",
      data: object.body,
    });
  }
}

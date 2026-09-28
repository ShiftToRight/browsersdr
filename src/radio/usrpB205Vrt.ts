export type UsrpB205ControlSid = 0x40 | 0x10;

export interface UsrpB205VrtPacket {
  readonly context: boolean;
  readonly hasTimestamp: boolean;
  readonly endOfBurst: boolean;
  readonly sequence: number;
  readonly byteLength: number;
  readonly sid: number;
  readonly timestamp: bigint | null;
  readonly payloadWords: readonly number[];
}

export interface UsrpB205ControlResponse {
  readonly sid: 0x00400000 | 0x00100000;
  readonly sequence: number;
  readonly timestamp: bigint;
  readonly readback: bigint;
}

const u32 = (view: DataView, offset: number) => view.getUint32(offset, true);

function viewOf(bytes: Uint8Array): DataView {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

export function encodeUsrpB205ControlRequest(
  sid: UsrpB205ControlSid,
  sequence: number,
  wireAddress: number,
  value: number,
): Uint8Array {
  if (sid !== 0x40 && sid !== 0x10) throw new Error("USRP B205-mini control request SID is outside the RX-only profile.");
  if (!Number.isInteger(sequence) || sequence < 0 || sequence > 0xfff) throw new Error("USRP B205-mini control sequence must be a 12-bit integer.");
  if (!Number.isInteger(wireAddress) || wireAddress < 0 || wireAddress > 0xffff_ffff
    || !Number.isInteger(value) || value < 0 || value > 0xffff_ffff) {
    throw new Error("USRP B205-mini control request words must be unsigned 32-bit integers.");
  }
  const bytes = new Uint8Array(16);
  const view = viewOf(bytes);
  view.setUint32(0, (0x80000010 | (sequence << 16)) >>> 0, true);
  view.setUint32(4, sid, true);
  view.setUint32(8, wireAddress, true);
  view.setUint32(12, value, true);
  return bytes;
}

export function decodeUsrpB205VrtPacket(bytes: Uint8Array): UsrpB205VrtPacket {
  if (bytes.byteLength < 8 || bytes.byteLength % 4 !== 0) throw new Error("Malformed USRP B205-mini VRT packet alignment/length.");
  const view = viewOf(bytes);
  const header = u32(view, 0);
  const byteLength = header & 0xffff;
  if (byteLength !== bytes.byteLength) throw new Error(`Malformed USRP B205-mini VRT length ${byteLength}/${bytes.byteLength}.`);
  const hasTimestamp = (header & 0x20000000) !== 0;
  const headerBytes = hasTimestamp ? 16 : 8;
  if (bytes.byteLength < headerBytes) throw new Error("Malformed USRP B205-mini VRT timestamp header.");
  const payloadWords: number[] = [];
  for (let offset = headerBytes; offset < bytes.byteLength; offset += 4) payloadWords.push(u32(view, offset));
  return {
    context: (header & 0x80000000) !== 0,
    hasTimestamp,
    endOfBurst: (header & 0x10000000) !== 0,
    sequence: (header >>> 16) & 0xfff,
    byteLength,
    sid: u32(view, 4),
    timestamp: hasTimestamp ? (BigInt(u32(view, 8)) << 32n) | BigInt(u32(view, 12)) : null,
    payloadWords,
  };
}

export function decodeUsrpB205ControlResponse(bytes: Uint8Array): UsrpB205ControlResponse {
  const packet = decodeUsrpB205VrtPacket(bytes);
  const header = u32(viewOf(bytes), 0);
  if (((header & 0xf000ffff) >>> 0) !== 0xa0000018 || packet.byteLength !== 24 || !packet.context
    || !packet.hasTimestamp || packet.endOfBurst || packet.payloadWords.length !== 2
    || (packet.sid !== 0x00400000 && packet.sid !== 0x00100000) || packet.timestamp === null) {
    throw new Error("Malformed USRP B205-mini control acknowledgement.");
  }
  return {
    sid: packet.sid as UsrpB205ControlResponse["sid"],
    sequence: packet.sequence,
    timestamp: packet.timestamp,
    readback: (BigInt(packet.payloadWords[0]!) << 32n) | BigInt(packet.payloadWords[1]!),
  };
}

/** Endpoint 8 is a byte stream; this parser owns no USB transfer assumptions. */
export class UsrpB205ControlAccumulator {
  private buffered = new Uint8Array();

  push(chunk: Uint8Array): readonly Uint8Array[] {
    const joined = new Uint8Array(this.buffered.byteLength + chunk.byteLength);
    joined.set(this.buffered);
    joined.set(chunk, this.buffered.byteLength);
    const packets: Uint8Array[] = [];
    let offset = 0;
    while (joined.byteLength - offset >= 4) {
      const length = new DataView(joined.buffer, joined.byteOffset + offset, 4).getUint16(0, true);
      if (length !== 24) throw new Error(`Malformed USRP B205-mini control packet length ${length}; expected 24.`);
      if (joined.byteLength - offset < length) break;
      packets.push(joined.slice(offset, offset + length));
      offset += length;
    }
    this.buffered = joined.slice(offset);
    if (this.buffered.byteLength > 48) throw new Error("USRP B205-mini control accumulator exceeded 48 bytes.");
    return packets;
  }

  reset(): void { this.buffered = new Uint8Array(); }
  get retainedByteLength(): number { return this.buffered.byteLength; }
}

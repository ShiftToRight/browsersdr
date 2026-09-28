import { decodeUsrpB205VrtPacket } from "./usrpB205Vrt";

export const USRP_B205_RX_SID = 0xa0 as const;
export const USRP_B205_RX_TRANSFER_BYTES = 16_360 as const;
export const USRP_B205_RX_MAX_PACKET_BYTES = 16_360 as const;
export const USRP_B205_RX_MAX_COMPLEX_SAMPLES = 4_086 as const;
export const USRP_B205_SC16_SCALE = 0.9999997558594347 / 32767;

export type UsrpB205InlineCode = 0x8 | 0x4 | 0x2 | 0xd;

export interface UsrpB205RxDataPacket {
  readonly kind: "data";
  readonly packetBytes: Uint8Array;
  readonly payloadBytes: Uint8Array;
  readonly sequence: number;
  readonly timestampTicks: bigint;
  readonly endOfBurst: boolean;
  readonly complexSampleCount: number;
}

export interface UsrpB205RxInlinePacket {
  readonly kind: "inline";
  readonly packetBytes: Uint8Array;
  readonly sequence: number;
  readonly timestampTicks: bigint;
  readonly code: number;
  readonly detail: number;
}

export type UsrpB205RxPacket = UsrpB205RxDataPacket | UsrpB205RxInlinePacket;

/** Endpoint 6 is a byte stream. Returned packets own their backing bytes. */
export class UsrpB205RxAccumulator {
  private buffered = new Uint8Array();

  push(chunk: Uint8Array): readonly Uint8Array[] {
    if (chunk.byteLength > USRP_B205_RX_TRANSFER_BYTES) throw new Error("USRP B205-mini RX transfer exceeds 16360 bytes.");
    // The FX3 normally returns one complete CHDR packet per 16,360-byte USB
    // transfer. Preserve that already-owned buffer instead of joining and then
    // slicing it (two full-rate copies). Fragmented/coalesced transfers still
    // use the general byte-stream path below.
    if (this.buffered.byteLength === 0 && chunk.byteLength >= 16) {
      const length = new DataView(
        chunk.buffer,
        chunk.byteOffset,
        4,
      ).getUint16(0, true);
      if (
        length === chunk.byteLength &&
        length <= USRP_B205_RX_MAX_PACKET_BYTES &&
        length % 4 === 0
      ) {
        return [
          chunk.byteOffset === 0 && chunk.byteLength === chunk.buffer.byteLength
            ? chunk
            : chunk.slice(),
        ];
      }
    }
    const joined = new Uint8Array(this.buffered.byteLength + chunk.byteLength);
    joined.set(this.buffered);
    joined.set(chunk, this.buffered.byteLength);
    const packets: Uint8Array[] = [];
    let offset = 0;
    while (joined.byteLength - offset >= 4) {
      const length = new DataView(joined.buffer, joined.byteOffset + offset, 4).getUint16(0, true);
      if (length < 16 || length > USRP_B205_RX_MAX_PACKET_BYTES || length % 4 !== 0) {
        // FX3 rounds a shortened overrun packet up by one 32-bit word. Its
        // firmware explicitly permits packet_length + 4 == DMA buffer count.
        // Accept only the observed all-zero word at the end of this USB chunk;
        // never scan forward or carry it into the next generation/chunk.
        if (offset > 0 && joined.byteLength - offset === 4
          && joined[offset] === 0 && joined[offset + 1] === 0
          && joined[offset + 2] === 0 && joined[offset + 3] === 0) {
          offset = joined.byteLength;
          break;
        }
        const snippet = [...joined.subarray(offset, Math.min(offset + 16, joined.byteLength))]
          .map((value) => value.toString(16).padStart(2, "0")).join(" ");
        throw new Error(
          `Malformed USRP B205-mini RX packet length ${length} at byte ${offset}/${joined.byteLength}`
          + ` (previously retained ${this.buffered.byteLength}, new chunk ${chunk.byteLength}; bytes ${snippet}).`,
        );
      }
      if (joined.byteLength - offset < length) break;
      packets.push(joined.slice(offset, offset + length));
      offset += length;
    }
    this.buffered = joined.slice(offset);
    if (this.buffered.byteLength > USRP_B205_RX_MAX_PACKET_BYTES) {
      throw new Error("USRP B205-mini RX accumulator exceeded 16360 bytes.");
    }
    return packets;
  }

  reset(): number {
    const discarded = this.buffered.byteLength;
    this.buffered = new Uint8Array();
    return discarded;
  }

  get retainedByteLength(): number { return this.buffered.byteLength; }
}

export function decodeUsrpB205RxPacket(packetBytes: Uint8Array): UsrpB205RxPacket {
  const packet = decodeUsrpB205VrtPacket(packetBytes);
  const header = new DataView(packetBytes.buffer, packetBytes.byteOffset, 4).getUint32(0, true);
  if (!packet.hasTimestamp || packet.sid !== USRP_B205_RX_SID || packet.timestamp === null) {
    throw new Error("Malformed USRP B205-mini RX SID or timestamp header.");
  }
  if (packet.context) {
    if (((header & 0xf000ffff) >>> 0) !== 0xa0000018 || packet.byteLength !== 24
      || packet.endOfBurst || packet.payloadWords.length !== 2) {
      throw new Error("Malformed USRP B205-mini inline packet.");
    }
    return { kind: "inline", packetBytes, sequence: packet.sequence, timestampTicks: packet.timestamp,
      code: packet.payloadWords[0]!, detail: packet.payloadWords[1]! };
  }
  if (((header & 0xe0000000) >>> 0) !== 0x20000000 || packet.byteLength < 16
    || packet.byteLength > USRP_B205_RX_MAX_PACKET_BYTES || packet.byteLength % 4 !== 0) {
    throw new Error("Malformed USRP B205-mini RX data packet.");
  }
  const payloadBytes = packetBytes.subarray(16);
  const complexSampleCount = payloadBytes.byteLength / 4;
  if (complexSampleCount === 0 && !packet.endOfBurst) throw new Error("USRP B205-mini RX data packet has no samples without EOB.");
  return { kind: "data", packetBytes, payloadBytes, sequence: packet.sequence,
    timestampTicks: packet.timestamp, endOfBurst: packet.endOfBurst, complexSampleCount };
}

export function decodeUsrpB205Sc16Into(
  bytes: Uint8Array,
  I: Float32Array,
  Q: Float32Array,
): number {
  const count = bytes.byteLength / 4;
  if (!Number.isInteger(count) || count > I.length || count > Q.length) throw new Error("Invalid bounded USRP B205-mini SC16 block.");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (let index = 0; index < count; index += 1) {
    Q[index] = view.getInt16(index * 4, true) * USRP_B205_SC16_SCALE;
    I[index] = view.getInt16(index * 4 + 2, true) * USRP_B205_SC16_SCALE;
  }
  return count;
}

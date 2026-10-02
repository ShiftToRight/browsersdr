import { dabPlusAccessUnitCrc, dabPlusFireCode } from "../dab/dabPlusSuperframe";
const EXP = new Uint8Array(510),
  LOG = new Int16Array(256).fill(-1);
let field = 1;
for (let index = 0; index < 255; index += 1) {
  EXP[index] = field;
  LOG[field] = index;
  field <<= 1;
  if (field & 0x100) field ^= 0x11d;
}
for (let index = 255; index < EXP.length; index += 1)
  EXP[index] = EXP[index - 255]!;
function mul(a: number, b: number) {
  return a && b ? EXP[LOG[a]! + LOG[b]!]! : 0;
}
function encode(data: Uint8Array): Uint8Array {
  let generator = Uint8Array.of(1);
  for (let root = 0; root < 10; root += 1) {
    const next = new Uint8Array(generator.length + 1);
    for (let index = 0; index < generator.length; index += 1) {
      next[index] = next[index]! ^ generator[index]!;
      next[index + 1] = next[index + 1]! ^ mul(generator[index]!, EXP[root]!);
    }
    generator = next;
  }
  const remainder = new Uint8Array(120);
  remainder.set(data);
  for (let index = 0; index < 110; index += 1) {
    const scale = remainder[index]!;
    if (!scale) continue;
    for (let coefficient = 0; coefficient < generator.length; coefficient += 1)
      remainder[index + coefficient] =
        remainder[index + coefficient]! ^ mul(scale, generator[coefficient]!);
  }
  const result = new Uint8Array(120);
  result.set(data);
  result.set(remainder.subarray(110), 110);
  return result;
}
function withCrc(payload: Uint8Array): Uint8Array {
  const framed = new Uint8Array(payload.length + 2),
    crc = dabPlusAccessUnitCrc(payload);
  framed.set(payload);
  framed[framed.length - 2] = crc >> 8;
  framed[framed.length - 1] = crc;
  return framed;
}
function makeSuperframe(firstPayload = new Uint8Array(20).fill(1)): Uint8Array {
  const data = new Uint8Array(110),
    aus = [
      withCrc(firstPayload),
      withCrc(new Uint8Array(30).fill(2)),
      withCrc(new Uint8Array(48).fill(3)),
    ];
  data[2] = 0x70; // 48 kHz DAC, SBR, stereo core => three AUs
  data[3] = 0x01;
  data[4] = 0xc0; // AU 1 starts at 28
  data[5] = 0x3c; // AU 2 starts at 60
  data.set(aus[0]!, 6);
  data.set(aus[1]!, 28);
  data.set(aus[2]!, 60);
  const fire = dabPlusFireCode(data.subarray(2, 11));
  data[0] = fire >> 8;
  data[1] = fire;
  return encode(data);
}

export { makeSuperframe, encode, withCrc };

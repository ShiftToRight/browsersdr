import { describe, expect, it } from "vitest";
import type { DigitalProvenance } from "../digital";
import {
  ACURITE_592_VECTOR,
  FINEOFFSET_WH51_VECTOR,
  FINEOFFSET_WH2_VECTOR,
} from "./fixtures/rtl433Vectors";
import {
  decodeAcurite592Burst,
  decodeAcurite592Bytes,
  decodeFineOffsetWh51Burst,
  decodeFineOffsetWh51Bytes,
  decodeFineOffsetWh2Bytes,
  decodeFineOffsetWh2Burst,
  crc8,
} from "./protocols";
import type { SrdBurst, SrdPulse } from "./types";

const provenance: DigitalProvenance = {
  generation: 4,
  firstInputSampleIndex: 1_000,
  lastInputSampleIndex: 20_000,
  actualInputSampleRateHz: 1_024_000,
  selectedChannelOffsetHz: 12_000,
};

function burst(pulses: SrdPulse[], modulation: "ook" | "2fsk"): SrdBurst {
  return {
    id: 1,
    modulation,
    pulses,
    pulseOverflow: 0,
    truncated: false,
    timingCandidates: [],
    provenance,
  };
}

function acuritePulses(bytes: Uint8Array): SrdPulse[] {
  const pulses: SrdPulse[] = [];
  let index = 0;
  for (const byte of bytes)
    for (let bit = 7; bit >= 0; bit--) {
      const high = byte & (1 << bit) ? 408 : 220;
      pulses.push({
        level: 1,
        durationUs: high,
        firstInputSampleIndex: index,
        lastInputSampleIndex: index,
      });
      pulses.push({
        level: 0,
        durationUs: 612 - high,
        firstInputSampleIndex: index,
        lastInputSampleIndex: index,
      });
      index++;
    }
  return pulses;
}

function fskPulses(bytes: Uint8Array): SrdPulse[] {
  const all = Uint8Array.from([0xaa, 0x2d, 0xd4, ...bytes]);
  const bits = [...all].flatMap((byte) =>
    Array.from({ length: 8 }, (_, bit) => ((byte >> (7 - bit)) & 1) as 0 | 1),
  );
  const pulses: SrdPulse[] = [];
  for (const bit of bits) {
    const last = pulses.at(-1);
    if (last?.level === bit) last.durationUs += 58;
    else
      pulses.push({
        level: bit,
        durationUs: 58,
        firstInputSampleIndex: 0,
        lastInputSampleIndex: 0,
      });
  }
  return pulses;
}

describe("selected SRD protocols", () => {
  it("decodes the independent Acurite 592TXR vector with checksum and parity", () => {
    expect(
      decodeAcurite592Bytes(ACURITE_592_VECTOR.bytes, { provenance }),
    ).toMatchObject(ACURITE_592_VECTOR.expected);
    expect(
      decodeAcurite592Burst(
        burst(acuritePulses(ACURITE_592_VECTOR.bytes), "ook"),
      ).reading,
    ).toMatchObject(ACURITE_592_VECTOR.expected);
  });

  it("rejects corrupt, parity-invalid, and truncated Acurite frames", () => {
    const corrupt = ACURITE_592_VECTOR.bytes.slice();
    corrupt[3] = corrupt[3]! ^ 1;
    expect(decodeAcurite592Bytes(corrupt, { provenance })).toBeUndefined();
    const badParity = ACURITE_592_VECTOR.bytes.slice();
    badParity[3] = badParity[3]! ^ 0x80;
    badParity[6] =
      badParity.subarray(0, 6).reduce((sum, value) => sum + value, 0) & 0xff;
    expect(decodeAcurite592Bytes(badParity, { provenance })).toBeUndefined();
    expect(
      decodeAcurite592Bytes(ACURITE_592_VECTOR.bytes.subarray(0, 6), {
        provenance,
      }),
    ).toBeUndefined();
  });

  it("decodes the independent WH51 vector with CRC-8 and additive checksum", () => {
    expect(
      decodeFineOffsetWh51Bytes(FINEOFFSET_WH51_VECTOR.bytes, { provenance }),
    ).toMatchObject(FINEOFFSET_WH51_VECTOR.expected);
    expect(
      decodeFineOffsetWh51Burst(
        burst(fskPulses(FINEOFFSET_WH51_VECTOR.bytes), "2fsk"),
      ).reading,
    ).toMatchObject(FINEOFFSET_WH51_VECTOR.expected);
  });

  it("rejects corrupt and truncated WH51 frames", () => {
    const corrupt = FINEOFFSET_WH51_VECTOR.bytes.slice();
    corrupt[8] = corrupt[8]! ^ 1;
    expect(decodeFineOffsetWh51Bytes(corrupt, { provenance })).toBeUndefined();
    expect(
      decodeFineOffsetWh51Bytes(FINEOFFSET_WH51_VECTOR.bytes.subarray(0, 13), {
        provenance,
      }),
    ).toBeUndefined();
  });
});

it("validates WH2/TFA exact frames, signed temperatures, absent humidity and corruption", () => {
  const bytes = FINEOFFSET_WH2_VECTOR.bytes;
  const pulses = [...Uint8Array.from([255, ...bytes])].flatMap((byte) =>
    Array.from({ length: 8 }, (_, n) => [
      {
        level: 1 as const,
        durationUs: byte & (128 >> n) ? 544 : 1524,
        firstInputSampleIndex: 0,
        lastInputSampleIndex: 0,
      },
      {
        level: 0 as const,
        durationUs: 1036,
        firstInputSampleIndex: 0,
        lastInputSampleIndex: 0,
      },
    ]).flat(),
  );
  const signal = burst(pulses, "ook");
  expect(decodeFineOffsetWh2Bytes(bytes, { provenance })).toMatchObject(
    FINEOFFSET_WH2_VECTOR.expected,
  );
  expect(decodeFineOffsetWh2Burst(signal).reading).toMatchObject(
    FINEOFFSET_WH2_VECTOR.expected,
  );
  const noisy = pulses.slice();
  noisy.splice(
    5,
    1,
    { ...pulses[5]!, durationUs: 500 },
    { ...pulses[4]!, durationUs: 8 },
    { ...pulses[5]!, durationUs: 528 },
  );
  expect(
    decodeFineOffsetWh2Burst({ ...signal, pulses: noisy }).reading,
  ).toMatchObject(FINEOFFSET_WH2_VECTOR.expected);
  expect(
    decodeFineOffsetWh2Burst({ ...signal, truncated: true }).reading,
  ).toBeUndefined();
  expect(
    decodeFineOffsetWh2Burst({ ...signal, modulation: "2fsk" }).reading,
  ).toBeUndefined();
  expect(
    decodeFineOffsetWh2Burst({ ...signal, pulses: pulses.slice(2) }).reading,
  ).toBeUndefined();
  for (let bit = 0; bit < 40; bit++) {
    const corrupt = bytes.slice();
    corrupt[bit >> 3] = corrupt[bit >> 3]! ^ (128 >> (bit & 7));
    expect(decodeFineOffsetWh2Bytes(corrupt, { provenance })).toBeUndefined();
  }
  const cold = Uint8Array.from([0x41, 0x28, 0x25, 255, 0]);
  cold[4] = crc8(cold.subarray(0, 4));
  expect(decodeFineOffsetWh2Bytes(cold, { provenance })).toMatchObject({
    temperatureC: -3.7,
    deviceId: "12",
  });
  expect(decodeFineOffsetWh2Bytes(cold, { provenance })).not.toHaveProperty(
    "humidityPercent",
  );
});

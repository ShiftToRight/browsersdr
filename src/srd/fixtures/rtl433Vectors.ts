/**
 * Small factual frame vectors transcribed/derived from rtl_433 regression
 * captures at commit 1aa8c29d6b9383739d1aeed495dbc5069b704392.
 * The upstream corpus has no repository-wide license file, so no capture bytes
 * are redistributed here. Expected fields come from the adjacent upstream JSON.
 */
export const RTL433_TEST_COMMIT = "1aa8c29d6b9383739d1aeed495dbc5069b704392";

export const ACURITE_592_VECTOR = {
  source: "tests/acurite/Acurite_592TXR/acurite-592txr-003.cu8 and .json",
  bytes: Uint8Array.from([0x2f, 0x15, 0x44, 0xca, 0x09, 0xf3, 0x4e]),
  expected: {
    deviceId: "2f15",
    channel: "C" as const,
    batteryOk: true,
    temperatureC: 26.7,
    humidityPercent: 74,
  },
};

export const FINEOFFSET_WH51_VECTOR = {
  source:
    "tests/fineoffset/fineoffset_wh51/01/g004_433.872M_250k.cu8 and .json",
  bytes: Uint8Array.from([
    0x51, 0x00, 0xc4, 0xf2, 0x6f, 0x7f, 0x00, 0xf8, 0x19, 0xff, 0xff, 0xff,
    0x9a, 0x9d,
  ]),
  expected: {
    deviceId: "00c4f2",
    batteryMillivolts: 1_500,
    batteryLevel: 0.9 as const,
    moisturePercent: 0,
    boost: 3,
    adRaw: 25,
  },
};

import { expect, it } from "vitest";
import { matchingSharedFrequencies } from "./sharedFrequencyGuides";

it("finds regional mesh presets by protocol, region and explicit frequency", () => {
  expect(
    matchingSharedFrequencies("meshtastic europe").map((p) => p.frequencyHz),
  ).toContain(869525000);
  const us = matchingSharedFrequencies("meshtastic us");
  expect(
    us.filter((p) => p.regions.includes("US")).map((p) => p.frequencyHz),
  ).toEqual([906875000, 908750000]);
  expect(
    matchingSharedFrequencies("meshcore germany").map((p) => p.frequencyHz),
  ).toContain(869618000);
  expect(
    matchingSharedFrequencies("meshtastic australia").map((p) => p.frequencyHz),
  ).toContain(919875000);
  expect(
    matchingSharedFrequencies("meshtastic japan").map((p) => p.frequencyHz),
  ).toContain(923375000);
  expect(matchingSharedFrequencies("869.525 MHz").map((p) => p.family)).toEqual(
    ["meshtastic", "lorawan", "lorawan"],
  );
  expect(matchingSharedFrequencies("908.75").map((p) => p.name)).toContain(
    "Meshtastic United States · LongTurbo (US)",
  );
  expect(matchingSharedFrequencies("not a known service")).toEqual([]);
});
it("keeps Zigbee and Thread distinct, includes all sixteen worldwide channels, and excludes held/deprecated profiles", () => {
  for (const family of ["zigbee", "thread"]) {
    const rows = matchingSharedFrequencies(family);
    expect(rows).toHaveLength(16);
    expect(rows[0]!.frequencyHz).toBe(2405000000);
    expect(rows[15]!.frequencyHz).toBe(2480000000);
  }
  expect(
    matchingSharedFrequencies("matter channel 26").map((p) => p.family),
  ).toEqual(["thread"]);
  expect(matchingSharedFrequencies("2480 MHz").map((p) => p.family)).toEqual([
    "zigbee",
    "thread",
    "bluetooth-le",
  ]);
  expect(matchingSharedFrequencies("meshtastic PH 868")).toEqual([]);
  expect(matchingSharedFrequencies("deprecated")).toEqual([]);
});

it("finds the additional protocol families without treating all of them as LoRa", () => {
  expect(
    matchingSharedFrequencies("bluetooth advertising").map(
      (p) => p.frequencyHz,
    ),
  ).toEqual([2402000000, 2426000000, 2480000000]);
  expect(
    matchingSharedFrequencies("lora").every((p) =>
      ["meshcore", "meshtastic", "lorawan"].includes(p.family),
    ),
  ).toBe(true);
  expect(matchingSharedFrequencies("gps l1").map((p) => p.frequencyHz)).toEqual(
    [1575420000],
  );
  expect(matchingSharedFrequencies("gnss").map((p) => p.id)).toContain(
    "galileo-e5a",
  );
  expect(matchingSharedFrequencies("noaa weather")).toHaveLength(7);
});

it("retains direction, bandwidth and national differences in numbered channel plans", () => {
  const us = matchingSharedFrequencies("lorawan us");
  expect(us.filter((p) => p.direction === "Uplink 125 kHz")).toHaveLength(64);
  expect(us.filter((p) => p.direction === "Uplink 500 kHz")).toHaveLength(8);
  expect(
    us.filter((p) => p.direction === "Downlink RX1").map((p) => p.frequencyHz),
  ).toEqual([
    923300000, 923900000, 924500000, 925100000, 925700000, 926300000, 926900000,
    927500000,
  ]);
  expect(
    matchingSharedFrequencies("lorawan as923 2").map((p) => p.frequencyHz),
  ).toContain(921400000);
  expect(matchingSharedFrequencies("uhf cb australia channel 61")).toEqual([]);
  expect(
    matchingSharedFrequencies("uhf cb new zealand channel 61").map(
      (p) => p.frequencyHz,
    ),
  ).toEqual([476937500]);
  expect(matchingSharedFrequencies("frs")).toHaveLength(22);
  expect(
    matchingSharedFrequencies("frs channel 22").map((p) => p.frequencyHz),
  ).toEqual([462725000]);
  expect(
    matchingSharedFrequencies("frs channel 2").map((p) => p.frequencyHz),
  ).toEqual([462587500]);
  expect(matchingSharedFrequencies("gmrs")).toHaveLength(30);
  expect(
    matchingSharedFrequencies("murs channel 5").map((p) => p.frequencyHz),
  ).toEqual([154600000]);
  expect(
    matchingSharedFrequencies("marine channel 70").map((p) => p.frequencyHz),
  ).toEqual([156525000]);
  expect(matchingSharedFrequencies("pmr446")).toHaveLength(48);
  const vietnam = matchingSharedFrequencies("lorawan vietnam");
  expect(vietnam).toHaveLength(4);
  expect(vietnam.every((p) => p.id.startsWith("lorawan-as923-2-"))).toBe(true);
});

it("publishes HF receiver dials with USB and variable audio offsets rather than carrier claims", () => {
  const ft8 = matchingSharedFrequencies("ft8 20m");
  expect(ft8.map((p) => p.frequencyHz)).toContain(14074000);
  for (const family of ["ft8", "ft4", "wspr", "js8"]) {
    const rows = matchingSharedFrequencies(family);
    expect(rows.length).toBeGreaterThan(0);
    expect(
      rows.every(
        (p) =>
          p.frequencyMeaning === "receiver_dial" && p.recommendedMode === "USB",
      ),
    ).toBe(true);
  }
  expect(matchingSharedFrequencies("wspr 20m")[0]?.frequencyHz).toBe(14095600);
  expect(matchingSharedFrequencies("wspr 20m")[0]?.notes).toContain(
    "1400–1600 Hz",
  );
  expect(matchingSharedFrequencies("js8 40m")[0]?.frequencyHz).toBe(7078000);
});

it("keeps worldwide 2.4 GHz channels discoverable for named countries", () => {
  expect(matchingSharedFrequencies("zigbee germany")).toHaveLength(16);
  expect(matchingSharedFrequencies("thread japan")).toHaveLength(16);
});

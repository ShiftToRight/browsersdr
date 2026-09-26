import { describe, expect, it } from "vitest";
import { APRS_FIXTURE_VECTORS } from "./fixtures/vectors";
import { parseAprsPayload } from "./payload";
import type { Ax25UiFrame } from "./types";

function frame(information: string, destination = "APRS"): Ax25UiFrame {
  return {
    destination: { callsign: destination, ssid: 0, repeated: false },
    source: { callsign: "N0CALL", ssid: 1, repeated: false },
    path: [],
    control: 0x03,
    pid: 0xf0,
    information: new TextEncoder().encode(information),
  };
}

describe("APRS payloads", () => {
  it("parses uncompressed position and preserves ambiguity", () => {
    const vector = APRS_FIXTURE_VECTORS.uncompressed;
    const payload = parseAprsPayload(frame(vector.information));
    expect(payload.kind).toBe("position");
    if (payload.kind !== "position" && payload.kind !== "mic-e") return;
    expect(payload.position.latitudeDegrees).toBeCloseTo(
      vector.latitudeDegrees,
      7,
    );
    expect(payload.position.longitudeDegrees).toBeCloseTo(
      vector.longitudeDegrees,
      7,
    );
    const ambiguous = parseAprsPayload(frame("!4903.  N/07201.  W-Test"));
    expect(
      ambiguous.kind === "position" && ambiguous.position.ambiguityDigits,
    ).toBe(2);
    expect(parseAprsPayload(frame("!9903.50N/99901.75W-Bad")).kind).toBe(
      "unsupported",
    );
  });

  it("parses compressed positions without manufacturing missing values", () => {
    const payload = parseAprsPayload(frame("!/5L!!<*e7>7P[compressed"));
    expect(payload.kind).toBe("position");
    if (payload.kind !== "position" && payload.kind !== "mic-e") return;
    expect(payload.position.format).toBe("compressed");
    expect(payload.position.latitudeDegrees).toBeGreaterThan(-90);
    expect(payload.position.longitudeDegrees).toBeLessThan(180);
  });

  it("parses a Dire Wolf Mic-E example", () => {
    const vector = APRS_FIXTURE_VECTORS.micE;
    const payload = parseAprsPayload(
      frame(vector.information, vector.destination),
    );
    expect(payload.kind).toBe("mic-e");
    if (payload.kind !== "mic-e" && payload.kind !== "position") return;
    expect(payload.position.latitudeDegrees).toBeCloseTo(
      vector.latitudeDegrees,
      7,
    );
    expect(payload.position.longitudeDegrees).toBeCloseTo(
      vector.longitudeDegrees,
      7,
    );
    expect(payload.speedMetersPerSecond).toBeCloseTo(
      vector.speedMetersPerSecond,
      6,
    );
    expect(payload.courseDegrees).toBe(vector.courseDegrees);
  });

  it("parses basic status, message, and supported weather units", () => {
    expect(parseAprsPayload(frame(">Net control")).kind).toBe("status");
    expect(parseAprsPayload(frame(":N0CALL-1 :hello{42"))).toMatchObject({
      kind: "message",
      addressee: "N0CALL-1",
      text: "hello",
      messageId: "42",
    });
    const vector = APRS_FIXTURE_VECTORS.weather;
    const payload = parseAprsPayload(frame(vector.information));
    expect(payload.kind).toBe("weather");
    if (payload.kind !== "weather") return;
    expect(payload.weather).toMatchObject({
      windDirectionDegrees: vector.windDirectionDegrees,
      humidityPercent: vector.humidityPercent,
      pressureHectopascals: vector.pressureHectopascals,
    });
    expect(payload.weather.windSpeedMetersPerSecond).toBeCloseTo(
      vector.windSpeedMetersPerSecond,
      5,
    );
    expect(payload.weather.temperatureCelsius).toBeCloseTo(
      vector.temperatureCelsius,
      5,
    );
  });
});

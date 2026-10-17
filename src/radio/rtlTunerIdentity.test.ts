import { expect, it } from "vitest";
import { R820T } from "@jtarrio/webrtlsdr/rtlsdr/r820t.js";
import { R828D } from "@jtarrio/webrtlsdr/rtlsdr/r828d.js";
import { rtlTunerIdentity } from "./rtlTunerIdentity";

it("recognizes only the pinned driver's actually probed tuner classes", () => {
  expect(rtlTunerIdentity({ tuner: Object.create(R820T.prototype) })).toBe(
    "R820T-family",
  );
  expect(rtlTunerIdentity({ tuner: Object.create(R828D.prototype) })).toBe(
    "R828D",
  );
  expect(
    rtlTunerIdentity({
      productName: "RTL-SDR Blog V4",
      tuner: { constructor: { name: "R828D" } },
    }),
  ).toBeUndefined();
  expect(rtlTunerIdentity(undefined)).toBeUndefined();
  expect(
    rtlTunerIdentity({
      get tuner() {
        throw new Error("Private state");
      },
    }),
  ).toBeUndefined();
});

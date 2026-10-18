// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { beforeEach, afterEach, expect, it, vi } from "vitest";
import { AntennaGuide } from "./AntennaGuide";
import type { AntennaContext } from "../radio/antennaGuide";
import { ANTENNA_TYPES } from "../radio/antennaDesigns";
import { customPresetKey } from "../radio/antennaPresets";
let root: Root;
let host: HTMLDivElement;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  localStorage.clear();
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});
async function render(context: AntennaContext) {
  await act(async () => root.render(<AntennaGuide context={context} />));
}
async function click(name: string) {
  await act(async () => {
    Array.from(host.querySelectorAll("button"))
      .find((button) => button.textContent === name)!
      .click();
  });
}
async function chooseAntenna(value: string) {
  await act(async () => {
    const select = host.querySelector<HTMLSelectElement>(
      ".antenna-choice select",
    )!;
    select.value = value;
    select.dispatchEvent(new Event("change", { bubbles: true }));
  });
}
async function select(label: string, value: string) {
  await act(async () => {
    const input = host.querySelector<HTMLSelectElement>(
      `select[aria-label="${label}"]`,
    )!;
    input.value = value;
    input.dispatchEvent(new Event("change", { bubbles: true }));
  });
}
async function fill(label: string, value: string) {
  await act(async () => {
    const input = host.querySelector<HTMLInputElement>(
      `input[aria-label="${label}"]`,
    )!;
    Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      "value",
    )!.set!.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
it("saves, updates, restores and deletes named custom presets with undo and duplicate protection", async () => {
  await render({
    kind: "local",
    sourceLabel: "HackRF",
    mode: "WBFM",
    frequencyHz: 100e6,
  });
  await select("Antenna preset", "ant700");
  await fill("Custom preset name", "Office whip");
  await click("Save as new preset");
  const read = () => JSON.parse(localStorage.getItem(customPresetKey)!).presets;
  const savedId = read()[0].id;
  expect(read()[0].name).toBe("Office whip");
  await fill("Maximum mast length (cm)", "12");
  await click("Update preset");
  expect(read()[0].maximumM).toBe(0.12);
  await click("Save as new preset");
  expect(read()).toHaveLength(1);
  expect(host.querySelector(".antenna-custom-manager")!.textContent).toContain(
    "already exists",
  );
  await select("Antenna preset", "rtl-long");
  expect(
    host.querySelector<HTMLSelectElement>(".antenna-choice select")!.value,
  ).toBe("dipole");
  await select("Antenna preset", savedId);
  expect(
    host.querySelector<HTMLSelectElement>(".antenna-choice select")!.value,
  ).toBe("whip");
  expect(
    host.querySelector<HTMLInputElement>(
      'input[aria-label="Maximum mast length (cm)"]',
    )!.value,
  ).toBe("12");
  await click("Delete preset");
  expect(read()).toHaveLength(0);
  await click("Undo delete");
  expect(read()[0].id).toBe(savedId);
  expect(
    host.querySelector<HTMLSelectElement>(
      'select[aria-label="Antenna preset"]',
    )!.value,
  ).toBe(savedId);
});
it("shows dipole section settings separately from full arm length and suggests the other element set", async () => {
  await render({
    kind: "local",
    sourceLabel: "RTL",
    mode: "WBFM",
    frequencyHz: 100e6,
  });
  await select("Antenna preset", "rtl-long");
  expect(
    host.querySelector(".antenna-dipole-lengths .antenna-whip-length strong")!
      .textContent,
  ).toBe("71.3 cm");
  expect(
    host.querySelector(".antenna-extension-target")!.textContent,
  ).toContain("69.3 cm per arm + 2.0 cm fixed section");
  expect(host.querySelector(".antenna-dipole-lengths")!.textContent).toContain(
    "1.43 m total span",
  );
  await render({
    kind: "local",
    sourceLabel: "RTL",
    mode: "NBFM",
    frequencyHz: 550e6,
  });
  await click("Use current channel");
  expect(host.querySelector(".antenna-fit")!.getAttribute("data-fit")).toBe(
    "too-short",
  );
  await click("Use short elements");
  expect(
    host.querySelector<HTMLSelectElement>(
      'select[aria-label="Antenna preset"]',
    )!.value,
  ).toBe("rtl-short");
  expect(host.querySelector(".antenna-fit")!.getAttribute("data-fit")).toBe(
    "fits",
  );
  expect(host.querySelector(".antenna-preset-controls")!.textContent).toContain(
    "cheat sheet says 14 cm",
  );
  await fill("Fixed feed section per arm (cm)", "30");
  expect(host.querySelector(".antenna-dipole-lengths")!.textContent).toContain(
    "shorter than the fixed",
  );
  expect(host.querySelector(".antenna-fit")).toBeNull();
});
it("keeps named presets usable in memory and reports a failed local save", async () => {
  await render({
    kind: "local",
    sourceLabel: "RTL",
    mode: "WBFM",
    frequencyHz: 100e6,
  });
  await select("Antenna preset", "ratlsnake");
  await fill("Custom preset name", "Magnetic base");
  const storage = vi
    .spyOn(Storage.prototype, "setItem")
    .mockImplementation(() => {
      throw Error("unavailable");
    });
  await click("Save as new preset");
  expect(host.querySelector(".antenna-custom-manager")!.textContent).toContain(
    "this tab only",
  );
  expect(
    Array.from(host.querySelectorAll("option")).some(
      (o) => o.textContent === "Magnetic base",
    ),
  ).toBe(true);
  storage.mockRestore();
});
it("loads ANT500 as a direct whip, compares both wave lengths and preserves physical limits across units", async () => {
  await render({
    kind: "local",
    sourceLabel: "HackRF",
    mode: "WBFM",
    frequencyHz: 75e6,
  });
  await chooseAntenna("telescopic");
  await select("Antenna preset", "ant500");
  expect(
    host.querySelector<HTMLSelectElement>(".antenna-choice select")!.value,
  ).toBe("whip");
  expect(host.querySelector(".antenna-fit")!.textContent).toContain(
    "exceeds the published maximum",
  );
  expect(host.querySelector(".antenna-whip-controls")!.textContent).toContain(
    "not a measured radiator range",
  );
  expect(
    host
      .querySelector(".antenna-monopole-drawing svg")!
      .getAttribute("aria-label"),
  ).toContain("Direct-attached");
  expect(host.querySelector(".antenna-eighth-result")).toBeNull();
  await act(async () =>
    host
      .querySelector<HTMLInputElement>(".antenna-eighth-toggle input")!
      .click(),
  );
  expect(host.querySelector(".antenna-eighth-result strong")!.textContent).toBe(
    "50.0 cm",
  );
  expect(host.querySelector(".antenna-eighth-result")!.textContent).toContain(
    "not automatically resonant",
  );
  await select("Antenna length units", "imperial");
  expect(host.querySelector(".antenna-fit")!.textContent).toContain(
    "exceeds the published maximum",
  );
  const saved = JSON.parse(
    localStorage.getItem("browsersdr.antenna-guide.v1")!,
  );
  expect(saved.preset).toBe("ant500");
  expect(saved.showEighth).toBe(true);
  expect(Number(saved.maximum)).toBeCloseTo(34.645669, 5);
  await chooseAntenna("telescopic");
  expect(
    host.querySelector<HTMLSelectElement>(
      'select[aria-label="Antenna preset"]',
    )!.value,
  ).toBe("custom");
  expect(host.querySelector(".antenna-fit")!.getAttribute("data-fit")).toBe(
    "unknown",
  );
});
it("rejects reversed custom limits and retains the draft when switching views", async () => {
  await render({
    kind: "local",
    sourceLabel: "RTL",
    mode: "WBFM",
    frequencyHz: 100e6,
  });
  await chooseAntenna("whip");
  await fill("Minimum mast length (cm)", "90");
  await fill("Maximum mast length (cm)", "20");
  expect(host.querySelector(".antenna-fit")!.getAttribute("data-fit")).toBe(
    "invalid",
  );
  await click("Length calculator");
  expect(
    host.querySelector<HTMLInputElement>(
      'input[aria-label="Maximum mast length (cm)"]',
    )!.value,
  ).toBe("20");
  expect(host.querySelector(".antenna-whip-controls")!.textContent).toContain(
    "Minimum length must not exceed",
  );
  await fill("Minimum mast length (cm)", "10");
  expect(host.querySelector(".antenna-fit")!.getAttribute("data-fit")).toBe(
    "too-long",
  );
});
it("renders every selected design without borrowing another form's setup or inventing complex dimensions", async () => {
  await render({
    kind: "local",
    sourceLabel: "RTL",
    mode: "WBFM",
    frequencyHz: 100e6,
  });
  for (const [value, name] of ANTENNA_TYPES) {
    if (value === "recommended") continue;
    await chooseAntenna(value);
    expect(host.querySelector(".antenna-start svg")).not.toBeNull();
    expect(host.querySelector(".antenna-start h4")!.textContent).toBe(
      value === "telescopic" ? "Telescopic monopole" : name,
    );
    if (
      ["qfh", "turnstile", "discone", "yagi", "log-periodic"].includes(value)
    ) {
      expect(host.querySelector(".antenna-start")!.textContent).not.toContain(
        "74.9 cm",
      );
      expect(host.querySelector(".antenna-whip-controls")).toBeNull();
    }
    if (value === "v-dipole")
      expect(host.querySelector(".antenna-start")!.textContent).toContain(
        "137 MHz reference only",
      );
    if (value === "qfh")
      expect(host.querySelector(".antenna-advice")!.textContent).toContain(
        "handedness",
      );
  }
  await chooseAntenna("recommended");
  expect(host.querySelector(".antenna-start h4")!.textContent).toBe(
    "Adjustable two-arm dipole",
  );
});
it("shows one telescopic mast length and matching diagram, with no dipole arm dimensions", async () => {
  await render({
    kind: "local",
    sourceLabel: "RTL-SDR",
    frequencyHz: 100e6,
    mode: "WBFM",
  });
  await chooseAntenna("telescopic");
  expect(host.querySelector(".antenna-start h4")!.textContent).toBe(
    "Telescopic monopole",
  );
  expect(host.querySelector(".antenna-whip-length strong")!.textContent).toBe(
    "74.9 cm",
  );
  expect(
    host
      .querySelector(".antenna-monopole-drawing svg")!
      .getAttribute("aria-label"),
  ).toContain("magnetic base");
  expect(host.querySelector(".antenna-dimension-note")).toBeNull();
  await click("Length calculator");
  expect(host.querySelector(".antenna-whip-length strong")!.textContent).toBe(
    "74.9 cm",
  );
  expect(host.querySelector(".antenna-metrics")).toBeNull();
  await chooseAntenna("recommended");
  expect(host.querySelectorAll(".antenna-metrics article")).toHaveLength(3);
});
it("migrates the existing units-only preference and saves the antenna choice without losing units", async () => {
  localStorage.setItem(
    "browsersdr.antenna-guide.v1",
    JSON.stringify({ version: 1, units: "imperial" }),
  );
  await render({
    kind: "local",
    sourceLabel: "RTL-SDR",
    frequencyHz: 100e6,
    mode: "WBFM",
  });
  expect(
    host.querySelector<HTMLSelectElement>(".antenna-choice select")!.value,
  ).toBe("recommended");
  await chooseAntenna("telescopic");
  expect(host.querySelector(".antenna-whip-length strong")!.textContent).toBe(
    "2.46 ft",
  );
  expect(
    JSON.parse(localStorage.getItem("browsersdr.antenna-guide.v1")!),
  ).toEqual({
    version: 1,
    units: "imperial",
    antenna: "telescopic",
    preset: "custom",
    minimum: "",
    maximum: "",
    showEighth: false,
    fixedSection: "0",
    originPreset: "",
  });
});
it("provides generic monopole dimensions for an uncatalogued mode without claiming a signal identity", async () => {
  await render({
    kind: "local",
    sourceLabel: "RTL-SDR",
    frequencyHz: 100e6,
    mode: "AM",
  });
  await chooseAntenna("telescopic");
  expect(host.querySelector("h3")!.textContent).toBe("Telescopic monopole");
  expect(host.querySelector(".antenna-whip-length strong")!.textContent).toBe(
    "74.9 cm",
  );
  expect(host.querySelector(".antenna-intro")!.textContent).toContain(
    "check signal-specific polarization",
  );
});
it("keeps a monopole's calculated length separate from the named satellite V-dipole design", async () => {
  await act(async () =>
    root.render(
      <AntennaGuide
        context={{
          kind: "local",
          sourceLabel: "RTL-SDR",
          frequencyHz: 137e6,
          mode: "OFF",
        }}
        initialGuideId="satellite"
      />,
    ),
  );
  await chooseAntenna("telescopic");
  expect(host.querySelector(".antenna-whip-length strong")!.textContent).toBe(
    "54.7 cm",
  );
  expect(host.querySelector(".antenna-advisory")!.textContent).toContain(
    "does not provide circular polarization",
  );
  expect(host.querySelector(".antenna-advice")!.textContent).not.toContain(
    "Place the V",
  );
  await chooseAntenna("recommended");
  expect(
    host.querySelector(".antenna-drawing svg")!.getAttribute("aria-label"),
  ).toContain("53.4 cm arms");
});
it("explains remote antenna ownership without substituting the listener's local tuning", async () => {
  await render({ kind: "remote", sourceLabel: "Remote receiver" });
  expect(host.querySelector(".antenna-context")!.textContent).toContain(
    "antenna at that site",
  );
  expect(host.querySelector(".antenna-context")!.textContent).toContain(
    "choose a frequency",
  );
  expect(host.querySelector(".antenna-empty")).not.toBeNull();
});
it("labels replay suggestions as learning rather than an observation of the original antenna", async () => {
  await render({
    kind: "replay",
    sourceLabel: "I/Q replay",
    mode: "WBFM",
    frequencyHz: 100e6,
  });
  expect(host.querySelector(".antenna-context")!.textContent).toContain(
    "cannot reveal which antenna was used",
  );
  expect(host.querySelector("h3")!.textContent).toBe("FM radio & RDS");
});
it("retains the original snapshot across context changes and refreshes only on deliberate action", async () => {
  await render({
    kind: "local",
    sourceLabel: "HackRF",
    mode: "WBFM",
    frequencyHz: 100e6,
  });
  await click("Length calculator");
  await render({
    kind: "local",
    sourceLabel: "HackRF",
    mode: "ADS-B",
    frequencyHz: 1090e6,
  });
  expect(
    host.querySelector<HTMLInputElement>(".antenna-frequency input")!.value,
  ).toBe("100 MHz");
  expect(host.querySelector('[role="status"]')!.textContent).toContain(
    "context changed",
  );
  await click("Use current channel");
  expect(
    host.querySelector<HTMLInputElement>(".antenna-frequency input")!.value,
  ).toBe("1090 MHz");
  expect(host.querySelector('[role="status"]')).toBeNull();
});
it("allows a calculation outside the current source range while labelling it separately", async () => {
  await render({
    kind: "local",
    sourceLabel: "bladeRF",
    frequencyHz: 1e6,
    mode: "AM",
    range: { minimumHz: 70e6, maximumHz: 6e9, limitsDiscoveredAtTune: false },
  });
  await click("Open length calculator");
  expect(host.querySelector(".antenna-advisory")!.textContent).toContain(
    "Calculation only",
  );
  expect(host.querySelectorAll(".antenna-metrics article")).toHaveLength(3);
});

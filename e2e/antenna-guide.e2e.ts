import { expect, test } from "@playwright/test";
import { openApplicationView } from "./application-navigation";

test("built-in antenna presets choose the right geometry and separate dipole extension from full arms", async ({
  page,
}, testInfo) => {
  await page.goto("/?browser-test=1");
  const channel = page.getByLabel("Channel frequency", { exact: true });
  await channel.fill("100");
  await channel.blur();
  await page.locator("#antenna-guide-trigger").click();
  const dialog = page.getByRole("dialog", {
    name: "Antenna guide",
    exact: true,
  });
  const preset = dialog.getByLabel("Antenna preset", { exact: true });
  await preset.selectOption("ant700");
  await expect(dialog.getByLabel("Antenna type", { exact: true })).toHaveValue(
    "whip",
  );
  await expect(
    dialog.getByLabel("Maximum mast length (cm)", { exact: true }),
  ).toHaveValue("24.5");
  await expect(dialog.locator(".antenna-fit")).toHaveAttribute(
    "data-fit",
    "too-long",
  );
  await preset.selectOption("ratlsnake");
  await expect(dialog.getByLabel("Antenna type", { exact: true })).toHaveValue(
    "telescopic",
  );
  await expect(
    dialog.getByLabel("Maximum mast length (cm)", { exact: true }),
  ).toHaveValue("");
  await expect(dialog.locator(".antenna-fit")).toHaveAttribute(
    "data-fit",
    "unknown",
  );
  await expect(dialog.locator(".antenna-preset-controls")).toContainText(
    "Mechanical extension limits are not published",
  );
  await preset.selectOption("rtl-long");
  await expect(dialog.getByLabel("Antenna type", { exact: true })).toHaveValue(
    "dipole",
  );
  await expect(
    dialog.getByLabel("Maximum adjustable section per arm (cm)", {
      exact: true,
    }),
  ).toHaveValue("100");
  await expect(
    dialog.getByLabel("Fixed feed section per arm (cm)", { exact: true }),
  ).toHaveValue("2");
  await expect(
    dialog.locator(".antenna-dipole-lengths .antenna-whip-length strong"),
  ).toHaveText("71.3 cm");
  await expect(dialog.locator(".antenna-extension-target")).toContainText(
    "69.3 cm per arm",
  );
  await expect(dialog.locator(".antenna-dipole-lengths")).toContainText(
    "1.43 m total span",
  );
  await dialog.locator(".antenna-dipole-lengths").scrollIntoViewIfNeeded();
  await page.screenshot({
    path: testInfo.outputPath("rtl-dipole-desktop.png"),
  });
  await dialog.getByRole("tab", { name: "Length calculator" }).click();
  await dialog.getByLabel("Frequency", { exact: true }).fill("550 MHz");
  await expect(dialog.locator(".antenna-fit")).toHaveAttribute(
    "data-fit",
    "too-short",
  );
  await dialog
    .getByRole("button", { name: "Use short elements", exact: true })
    .click();
  await expect(preset).toHaveValue("rtl-short");
  await expect(dialog.locator(".antenna-fit")).toHaveAttribute(
    "data-fit",
    "fits",
  );
  await expect(dialog.locator(".antenna-preset-controls")).toContainText(
    "cheat sheet says 14 cm",
  );
  await dialog.getByLabel("Antenna length units").selectOption("imperial");
  await dialog.getByLabel("Antenna length units").selectOption("metric");
  await expect(
    dialog.getByLabel("Fixed feed section per arm (cm)", { exact: true }),
  ).toHaveValue("2");
  await page.keyboard.press("Escape");
  await expect(channel).toHaveValue("100.000");
});

test("mobile named antenna presets save, update, switch, delete, undo and survive reload from Search", async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/?browser-test=1");
  await page.getByRole("button", { name: "Search", exact: true }).click();
  const search = page.getByRole("dialog", {
    name: "Search stations & signals",
  });
  await search.getByRole("searchbox").fill("fm");
  await search
    .getByRole("button", {
      name: "Antenna setup for Broadcast FM / RDS",
      exact: true,
    })
    .click();
  const preset = search.getByLabel("Antenna preset", { exact: true });
  await preset.selectOption("ratlsnake");
  await search
    .getByLabel("Minimum mast length (cm)", { exact: true })
    .fill("20");
  await search
    .getByLabel("Maximum mast length (cm)", { exact: true })
    .fill("80");
  await search.getByLabel("Show eighth-wave experiment").check();
  await search
    .getByText("Save & manage custom presets", { exact: true })
    .click();
  const name = search.getByLabel("Custom preset name", { exact: true });
  await name.fill("Window whip");
  await search
    .getByRole("button", { name: "Save as new preset", exact: true })
    .click();
  await expect(preset.locator("option:checked")).toHaveText("Window whip");
  await name.fill("Window mast");
  await search
    .getByLabel("Maximum mast length (cm)", { exact: true })
    .fill("82");
  await search
    .getByRole("button", { name: "Update preset", exact: true })
    .click();
  await search
    .getByRole("button", { name: "Save as new preset", exact: true })
    .click();
  await expect(search.locator(".antenna-custom-manager")).toContainText(
    "already exists",
  );
  await preset.selectOption("ant700");
  await preset.selectOption({ label: "Window mast" });
  await expect(search.getByLabel("Antenna type", { exact: true })).toHaveValue(
    "telescopic",
  );
  await expect(
    search.getByLabel("Maximum mast length (cm)", { exact: true }),
  ).toHaveValue("82");
  await search
    .getByRole("button", { name: "Delete preset", exact: true })
    .click();
  await search
    .getByRole("button", { name: "Undo delete", exact: true })
    .click();
  await expect(preset.locator("option:checked")).toHaveText("Window mast");
  expect(await search.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(
    true,
  );
  await search.locator(".antenna-custom-manager").scrollIntoViewIfNeeded();
  await page.screenshot({
    path: testInfo.outputPath("custom-presets-phone.png"),
  });
  await expect(page.locator("dialog[open]")).toHaveCount(1);
  await search
    .getByRole("button", { name: "← Back to Search", exact: true })
    .click();
  await expect(search.getByRole("searchbox")).toHaveValue("fm");
  await page.keyboard.press("Escape");
  await page.reload();
  await page.locator("#antenna-guide-trigger").click();
  const guide = page.getByRole("dialog", {
    name: "Antenna guide",
    exact: true,
  });
  await expect(
    guide
      .getByLabel("Antenna preset", { exact: true })
      .locator("option:checked"),
  ).toHaveText("Window mast");
  await expect(
    guide.getByLabel("Maximum mast length (cm)", { exact: true }),
  ).toHaveValue("82");
  await expect(guide.getByLabel("Show eighth-wave experiment")).toBeChecked();
});

test("ANT500 limits and optional compact experiment survive units and reload without tuning", async ({
  page,
}, testInfo) => {
  await page.goto("/?browser-test=1");
  const channel = page.getByLabel("Channel frequency", { exact: true });
  await channel.fill("100");
  await channel.blur();
  await page.locator("#antenna-guide-trigger").click();
  const dialog = page.getByRole("dialog", {
    name: "Antenna guide",
    exact: true,
  });
  await dialog.getByLabel("Antenna type", { exact: true }).selectOption("whip");
  await dialog
    .getByLabel("Antenna preset", { exact: true })
    .selectOption("ant500");
  await expect(
    dialog.getByLabel("Minimum mast length (cm)", { exact: true }),
  ).toHaveValue("20");
  await expect(
    dialog.getByLabel("Maximum mast length (cm)", { exact: true }),
  ).toHaveValue("88");
  await expect(dialog.locator(".antenna-fit")).toContainText(
    "within the published envelope",
  );
  await expect(
    dialog.getByRole("img", { name: /Direct-attached telescopic whip/ }),
  ).toBeVisible();
  await expect(dialog.locator(".antenna-eighth-result")).toHaveCount(0);
  await dialog.getByLabel("Show eighth-wave experiment").check();
  await dialog.getByRole("tab", { name: "Length calculator" }).click();
  await dialog.getByLabel("Frequency", { exact: true }).fill("75 MHz");
  await expect(dialog.locator(".antenna-whip-length strong")).toHaveText(
    "99.9 cm",
  );
  await expect(dialog.locator(".antenna-fit").first()).toContainText(
    "exceeds the published maximum",
  );
  await expect(dialog.locator(".antenna-eighth-result strong")).toHaveText(
    "50.0 cm",
  );
  await expect(dialog.locator(".antenna-eighth-result")).toContainText(
    "not automatically resonant or matched",
  );
  await page.screenshot({
    path: testInfo.outputPath("ant500-limits-desktop.png"),
  });
  await dialog.locator(".antenna-eighth-result").scrollIntoViewIfNeeded();
  await page.screenshot({
    path: testInfo.outputPath("ant500-compact-desktop.png"),
  });
  await dialog.getByLabel("Antenna length units").selectOption("imperial");
  await expect(
    dialog.getByLabel("Maximum mast length (in)", { exact: true }),
  ).toHaveValue("34.645669");
  await expect(dialog.locator(".antenna-fit").first()).toHaveAttribute(
    "data-fit",
    "too-long",
  );
  await dialog
    .getByLabel("Minimum mast length (in)", { exact: true })
    .fill("40");
  await expect(dialog.locator(".antenna-fit").first()).toHaveAttribute(
    "data-fit",
    "invalid",
  );
  await expect(
    dialog.getByLabel("Minimum mast length (in)", { exact: true }),
  ).toHaveAttribute("aria-invalid", "true");
  await dialog
    .getByLabel("Antenna preset", { exact: true })
    .selectOption("ant500");
  await dialog.getByLabel("Antenna length units").selectOption("metric");
  await dialog.getByLabel("Frequency", { exact: true }).fill("433 MHz");
  await expect(dialog.locator(".antenna-whip-length strong")).toHaveText(
    "17.3 cm",
  );
  await expect(dialog.locator(".antenna-fit").first()).toHaveAttribute(
    "data-fit",
    "too-short",
  );
  await expect(dialog.locator(".antenna-eighth-result strong")).toHaveText(
    "8.7 cm",
  );
  await page.reload();
  await page.locator("#antenna-guide-trigger").click();
  await expect(
    dialog.getByLabel("Antenna preset", { exact: true }),
  ).toHaveValue("ant500");
  await expect(dialog.getByLabel("Show eighth-wave experiment")).toBeChecked();
  await expect(
    dialog.getByLabel("Maximum mast length (cm)", { exact: true }),
  ).toHaveValue("88");
  await page.keyboard.press("Escape");
  await expect(channel).toHaveValue("100.000");
});

test("mobile antenna forms have matching diagrams and advice within the existing Search dialog", async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/?browser-test=1");
  await page.getByRole("button", { name: "Search", exact: true }).click();
  const dialog = page.getByRole("dialog", {
    name: "Search stations & signals",
  });
  await dialog.getByRole("searchbox").fill("fm");
  await dialog
    .getByRole("button", {
      name: "Antenna setup for Broadcast FM / RDS",
      exact: true,
    })
    .click();
  await dialog.getByLabel("Antenna type", { exact: true }).selectOption("whip");
  await dialog
    .getByLabel("Antenna preset", { exact: true })
    .selectOption("ant500");
  await dialog.getByLabel("Show eighth-wave experiment").check();
  await page.screenshot({ path: testInfo.outputPath("ant500-phone.png") });
  for (const [value, image] of [
    ["dipole", "Center-fed half-wave dipole"],
    ["ground-plane", "Vertical quarter-wave radiator"],
    ["v-dipole", "137 MHz V-dipole"],
    ["qfh", "QFH concept"],
    ["turnstile", "Turnstile: two crossed dipoles"],
    ["discone", "Discone: disc above cone"],
    ["yagi", "Yagi: reflector"],
    ["log-periodic", "Log-periodic dipole array:"],
  ] as const) {
    await dialog
      .getByLabel("Antenna type", { exact: true })
      .selectOption(value);
    await expect(
      dialog
        .locator(".antenna-start")
        .getByRole("img", { name: new RegExp(image) }),
    ).toBeVisible();
    await expect(dialog.locator(".antenna-whip-controls")).toHaveCount(0);
    expect(
      await dialog.evaluate((el) => el.scrollWidth <= el.clientWidth),
    ).toBe(true);
    if (value === "qfh") {
      await expect(dialog.locator(".antenna-advice")).toContainText(
        "handedness",
      );
      await dialog.locator(".antenna-start").scrollIntoViewIfNeeded();
      await page.screenshot({ path: testInfo.outputPath("qfh-phone.png") });
    }
    if (value === "discone")
      await expect(dialog.locator(".antenna-start")).not.toContainText(
        "74.9 cm",
      );
  }
  await dialog
    .getByLabel("Antenna type", { exact: true })
    .selectOption("recommended");
  await expect(dialog.locator(".antenna-start h4")).toHaveText(
    "Adjustable two-arm dipole",
  );
  await expect(page.locator("dialog[open]")).toHaveCount(1);
  await dialog
    .getByRole("button", { name: "← Back to Search", exact: true })
    .click();
  await expect(dialog.getByRole("searchbox")).toHaveValue("fm");
});

test("telescopic monopole uses a single whip length and matching diagram, retained in calculator and after reload", async ({
  page,
}, testInfo) => {
  await page.goto("/?browser-test=1");
  const channel = page.getByLabel("Channel frequency", { exact: true });
  await channel.fill("100");
  await channel.blur();
  await page.locator("#antenna-guide-trigger").click();
  const dialog = page.getByRole("dialog", {
    name: "Antenna guide",
    exact: true,
  });
  await dialog
    .getByLabel("Antenna type", { exact: true })
    .selectOption("telescopic");
  await expect(
    dialog.getByRole("heading", { name: "Telescopic monopole", exact: true }),
  ).toBeVisible();
  await expect(dialog.locator(".antenna-whip-length strong")).toHaveText(
    "74.9 cm",
  );
  await expect(
    dialog.getByRole("img", { name: /Telescopic monopole on a magnetic base/ }),
  ).toBeVisible();
  await expect(dialog.locator(".antenna-dimension-note")).toHaveCount(0);
  await page.screenshot({ path: testInfo.outputPath("monopole-desktop.png") });
  await dialog.locator(".antenna-start").scrollIntoViewIfNeeded();
  await page.screenshot({ path: testInfo.outputPath("monopole-setup.png") });
  await dialog.getByRole("tab", { name: "Length calculator" }).click();
  await dialog.getByLabel("Frequency", { exact: true }).fill("225.648 MHz");
  await expect(dialog.locator(".antenna-whip-length strong")).toHaveText(
    "33.2 cm",
  );
  await dialog.getByLabel("Frequency", { exact: true }).fill("403 MHz");
  await expect(dialog.locator(".antenna-whip-length strong")).toHaveText(
    "18.6 cm",
  );
  await dialog.getByLabel("Antenna length units").selectOption("imperial");
  await expect(dialog.locator(".antenna-whip-length strong")).toHaveText(
    "7.32 in",
  );
  await page.keyboard.press("Escape");
  await expect(channel).toHaveValue("100.000");
  await page.reload();
  await page.locator("#antenna-guide-trigger").click();
  await expect(dialog.getByLabel("Antenna type", { exact: true })).toHaveValue(
    "telescopic",
  );
  await expect(dialog.getByLabel("Antenna length units")).toHaveValue(
    "imperial",
  );
  await expect(dialog.locator(".antenna-whip-length strong")).toHaveText(
    "2.46 ft",
  );
});

test("mobile monopole choice preserves satellite alternatives and works from Search", async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/?browser-test=1");
  await page.getByRole("button", { name: "Search", exact: true }).click();
  const search = page.getByRole("dialog", {
    name: "Search stations & signals",
  });
  await search.getByRole("searchbox").fill("fm");
  await search
    .getByRole("button", {
      name: "Antenna setup for Broadcast FM / RDS",
      exact: true,
    })
    .click();
  await search
    .getByLabel("Antenna type", { exact: true })
    .selectOption("telescopic");
  await expect(search.locator(".antenna-whip-length strong")).toHaveText(
    "74.9 cm",
  );
  await expect(page.locator("dialog[open]")).toHaveCount(1);
  expect(await search.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(
    true,
  );
  await search.getByRole("tab", { name: "Browse guides" }).click();
  await search
    .getByRole("button", { name: /Weather satellite images/ })
    .click();
  await expect(search.locator(".antenna-whip-length strong")).toHaveText(
    "54.7 cm",
  );
  await expect(search.locator(".antenna-advisory")).toContainText(
    "does not provide circular polarization",
  );
  await page.screenshot({ path: testInfo.outputPath("monopole-phone.png") });
  await search
    .getByLabel("Antenna type", { exact: true })
    .selectOption("recommended");
  await expect(
    search.getByRole("img", { name: /137 MHz V-dipole/ }),
  ).toBeVisible();
  await search
    .getByRole("button", { name: "← Back to Search", exact: true })
    .click();
  await expect(search.getByRole("searchbox")).toHaveValue("fm");
});

test("antenna calculator uses selected-channel context, validates dimensions and retains drafts without tuning", async ({
  page,
}, testInfo) => {
  const errors: string[] = [];
  const antennaRequests: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("request", (request) => {
    if (/\/AntennaGuide(?:\.tsx|-)/.test(request.url()))
      antennaRequests.push(request.url());
  });
  await page.goto("/?browser-test=1");
  const channel = page.getByLabel("Channel frequency", { exact: true });
  await channel.fill("100");
  await channel.blur();
  expect(antennaRequests).toEqual([]);
  await page.locator("#antenna-guide-trigger").click();
  const dialog = page.getByRole("dialog", {
    name: "Antenna guide",
    exact: true,
  });
  await expect(
    dialog.getByRole("heading", { name: "FM radio & RDS" }),
  ).toBeVisible();
  expect(antennaRequests.length).toBeGreaterThan(0);
  await page.screenshot({ path: testInfo.outputPath("antenna-desktop.png") });
  await dialog.getByRole("tab", { name: "Length calculator" }).click();
  const input = dialog.getByLabel("Frequency", { exact: true });
  await expect(input).toHaveValue("100 MHz");
  await expect(
    dialog.locator(".antenna-metrics article").first(),
  ).toContainText("74.9 cm");
  await expect(dialog.locator(".antenna-metrics article").nth(1)).toContainText(
    "71.3 cm–74.9 cm",
  );
  await input.fill("0");
  await expect(input).toHaveAttribute("aria-invalid", "true");
  await expect(dialog.locator(".antenna-metrics")).toHaveCount(0);
  await input.fill("1,09 GHz");
  await expect(
    dialog.locator(".antenna-metrics article").first(),
  ).toContainText("6.9 cm");
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  await expect(page.locator("#antenna-guide-trigger")).toBeFocused();
  await expect(channel).toHaveValue("100.000");
  await channel.fill("101");
  await channel.blur();
  await page.locator("#antenna-guide-trigger").click();
  await expect(input).toHaveValue("1,09 GHz");
  await expect(dialog.getByRole("status")).toContainText("context changed");
  await dialog.getByRole("button", { name: "Use current channel" }).click();
  await expect(input).toHaveValue("101 MHz");
  await expect(dialog.getByRole("status")).toHaveCount(0);
  expect(errors).toEqual([]);
});

test("antenna guides expose six setups, satellite geometry and sources, with mobile keyboard access", async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/?browser-test=1");
  await page.locator("#antenna-guide-trigger").click();
  const dialog = page.getByRole("dialog", {
    name: "Antenna guide",
    exact: true,
  });
  await dialog.getByRole("tab", { name: "Browse guides" }).click();
  await expect(dialog.locator(".antenna-catalog-card")).toHaveCount(6);
  await dialog
    .getByRole("button", { name: /Weather satellite images/ })
    .click();
  await expect(
    dialog.getByRole("img", { name: /137 MHz V-dipole/ }),
  ).toBeVisible();
  await expect(dialog.locator(".antenna-capability")).toContainText(
    "decode externally",
  );
  await dialog
    .getByText("Setup details & an optional upgrade", { exact: true })
    .click();
  await expect(dialog.getByRole("img", { name: /QFH concept/ })).toBeVisible();
  await dialog.getByText("Sources & assumptions", { exact: true }).click();
  await expect(dialog.getByRole("link", { name: /NOAA/ })).toBeVisible();
  expect(await dialog.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(
    true,
  );
  await dialog.getByRole("tab", { name: "For this signal" }).focus();
  await page.keyboard.press("ArrowRight");
  await expect(
    dialog.getByRole("tab", { name: "Length calculator" }),
  ).toBeFocused();
  await expect(
    dialog.getByRole("tab", { name: "Length calculator" }),
  ).toHaveAttribute("aria-selected", "true");
  await dialog.getByLabel("Antenna length units").selectOption("imperial");
  await expect(
    dialog.locator(".antenna-metrics article").first(),
  ).toContainText("ft");
  const close = dialog.getByRole("button", { name: "Close utility overlay" });
  await close.scrollIntoViewIfNeeded();
  await expect(close).toBeInViewport();
  await page.screenshot({ path: testInfo.outputPath("antenna-phone.png") });
  const back = dialog.getByRole("button", {
    name: "Back to Receiver",
    exact: true,
  });
  await back.focus();
  await page.keyboard.press("Tab");
  await expect(close).toBeFocused();
  await close.click();
  await expect(dialog).toBeHidden();
  await page.reload();
  await page.locator("#antenna-guide-trigger").click();
  await expect(page.getByLabel("Antenna length units")).toHaveValue("imperial");
});

test("Search antenna handoff keeps a single modal and restores the query and focus without applying settings", async ({
  page,
}) => {
  await page.goto("/?browser-test=1");
  const channel = page.getByLabel("Channel frequency", { exact: true });
  const before = await channel.inputValue();
  await page.getByRole("button", { name: "Search", exact: true }).click();
  const dialog = page.getByRole("dialog", {
    name: "Search stations & signals",
  });
  const query = dialog.getByRole("searchbox");
  await query.fill("adsb");
  const setup = dialog.getByRole("button", {
    name: "Antenna setup for ADS-B / 1090ES",
    exact: true,
  });
  await setup.click();
  await expect(
    dialog.getByRole("heading", { name: "Aircraft · ADS-B", exact: true }),
  ).toBeVisible();
  await expect(page.locator("dialog[open]")).toHaveCount(1);
  await dialog
    .getByRole("button", { name: "← Back to Search", exact: true })
    .click();
  await expect(query).toHaveValue("adsb");
  await expect(setup).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  await expect(channel).toHaveValue(before);
});

test("antenna browsing preserves ongoing synthetic acquisition and I/Q recording", async ({
  page,
}) => {
  await page.goto("/?browser-test=1");
  await page
    .getByRole("combobox", { name: "Signal source", exact: true })
    .selectOption("synthetic");
  await page.getByRole("button", { name: "Start demo", exact: true }).click();
  await page
    .getByRole("tab", { name: "Capture & replay", exact: true })
    .click();
  await page.getByLabel("Timed capture seconds").fill("0");
  await page
    .getByRole("button", { name: "Start I/Q recording", exact: true })
    .click();
  const status = page.locator(".receiver-status-menu > summary");
  await expect(status).toContainText("Recording");
  const before = await page.locator(".recording-state span").textContent();
  await page.locator("#antenna-guide-trigger").click();
  const dialog = page.getByRole("dialog", {
    name: "Antenna guide",
    exact: true,
  });
  await expect(dialog.locator(".antenna-context")).toContainText(
    "Synthetic demo",
  );
  await dialog.getByRole("tab", { name: "Browse guides" }).click();
  await dialog.getByRole("button", { name: /Ships · AIS/ }).click();
  await expect(status).toContainText("Recording");
  await expect
    .poll(() => page.locator(".recording-state span").textContent())
    .not.toBe(before);
  await page.keyboard.press("Escape");
  await page
    .getByRole("button", { name: "Stop recording", exact: true })
    .click();
  await expect(page.locator(".receiver-status")).toContainText(
    "Ready to download",
  );
  await page.getByRole("button", { name: "Stop", exact: true }).click();
});

test("Help links reach the guide within its overlay and unknown modes have a useful fallback", async ({
  page,
}) => {
  await page.goto("/?browser-test=1");
  await page
    .getByRole("combobox", { name: "Mode", exact: true })
    .selectOption("AM");
  await openApplicationView(page, "Help");
  const dialog = page.locator(".utility-overlay");
  await dialog
    .getByText("Which antenna should I use?", { exact: true })
    .click();
  await dialog
    .getByRole("button", { name: "Open antenna guide", exact: true })
    .click();
  await expect(page.locator("dialog[open]")).toHaveCount(1);
  await expect(
    dialog.getByRole("heading", { name: "Choose what you want to receive" }),
  ).toBeVisible();
  await dialog
    .getByRole("button", { name: "Open length calculator", exact: true })
    .click();
  await expect(dialog.getByLabel("Frequency", { exact: true })).toBeVisible();
});

test("remote antenna advice never substitutes the local channel for the remote installation", async ({
  page,
}) => {
  await page.goto("/?browser-test=1");
  await page
    .getByRole("combobox", { name: "Signal source", exact: true })
    .selectOption("remote");
  await openApplicationView(page, "Help");
  const dialog = page.locator(".utility-overlay");
  await dialog
    .getByRole("button", { name: "Antenna guide", exact: true })
    .click();
  await expect(dialog.locator(".antenna-context")).toContainText(
    "antenna at that site",
  );
  await expect(dialog.locator(".antenna-context strong")).toHaveText(
    "Remote receiver · choose a frequency",
  );
  await expect(
    dialog.getByRole("heading", { name: "Choose what you want to receive" }),
  ).toBeVisible();
});

import { expect, test, type Page } from "@playwright/test";
async function receiver(page: Page, denied = false) {
  const commands: string[] = [],
    closed: string[] = [],
    urls: string[] = [];
  await page.routeWebSocket(
    /wss:\/\/kiwi\.example\/ws\/kiwi\/\d+\/(SND|W\/F)/,
    (socket) => {
      const sound = socket.url().endsWith("SND");
      urls.push(socket.url());
      let timer: ReturnType<typeof setInterval> | undefined,
        sequence = 0;
      socket.onClose(() => {
        if (timer) clearInterval(timer);
        closed.push(sound ? "sound" : "waterfall");
      });
      socket.onMessage((message) => {
        if (typeof message !== "string") return;
        commands.push(message);
        if (message.startsWith("SET auth")) {
          if (denied) {
            socket.send("MSG badp=1");
            return;
          }
          socket.send(
            sound
              ? "MSG badp=0 version_maj=1 version_min=800 bandwidth=30000000 freq_offset=0 audio_rate=12000 sample_rate=12000.025"
              : "MSG badp=0 wf_fft_size=1024 zoom_max=14 zoom_cap=12 wf_setup",
          );
        }
        if (sound && message.startsWith("SET mod=")) {
          if (timer) clearInterval(timer);
          timer = setInterval(() => {
            const pcm = Buffer.alloc(1034);
            pcm.write("SND");
            pcm.writeUInt32LE(sequence++, 4);
            for (let i = 0; i < 512; i++)
              pcm.writeInt16BE(Math.round(Math.sin(i / 8) * 2000), 10 + 2 * i);
            socket.send(pcm);
          }, 100);
        }
        if (!sound && message.startsWith("SET zoom=")) {
          const match = /zoom=(\d+) start=(\d+)/.exec(message)!;
          if (timer) clearInterval(timer);
          timer = setInterval(() => {
            const wf = Buffer.alloc(1040, 155);
            wf.write("W/F ");
            wf.writeUInt32LE(Number(match[2]), 4);
            wf.writeUInt32LE(Number(match[1]), 8);
            wf.writeUInt32LE(sequence++, 12);
            wf.fill(215, 516, 522);
            socket.send(wf);
          }, 100);
        }
      });
    },
  );
  await page.goto("/?browser-test=1");
  await page
    .getByRole("combobox", { name: "Signal source", exact: true })
    .selectOption("remote");
  await page
    .getByRole("combobox", { name: "Remote receiver type", exact: true })
    .selectOption("kiwi");
  await page
    .getByRole("textbox", { name: "Receiver website", exact: true })
    .fill("https://kiwi.example/");
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  return { commands, closed, urls };
}
test("KiwiSDR manual audio, per-client tuning, CW, zoom and cleanup preserve local settings", async ({
  page,
}) => {
  const { commands, closed, urls } = await receiver(page);
  await expect(page.locator(".remote-header-status")).toContainText(
    "connected",
  );
  await page.getByText("Stream details & filters", { exact: true }).click();
  await expect(page.locator(".remote-footer")).toContainText("0 audio samples");
  expect(urls).toHaveLength(2);
  expect(commands).toContain("SET compression=0");
  expect(commands).toContain("SET wf_comp=0");
  await page.getByRole("button", { name: "Listen", exact: true }).click();
  await expect(page.locator(".remote-footer")).toContainText("audio running");
  await expect
    .poll(async () => {
      const details = await page.locator(".remote-footer").innerText();
      const samples = /([\d,]+) audio samples/.exec(details);
      return Number((samples?.[1] ?? "0").replaceAll(",", ""));
    })
    .toBeGreaterThan(0);
  const pixels = await page
    .getByRole("img", {
      name: "Remote server spectrum and waterfall, relative power",
    })
    .evaluate((el) => {
      const c = el as HTMLCanvasElement;
      return Array.from(
        c.getContext("2d")!.getImageData(0, 112, 1024, 30).data,
      ).some((value, i) => i % 4 === 0 && value > 10);
    });
  expect(pixels).toBe(true);
  await page
    .getByRole("combobox", { name: "Waterfall zoom", exact: true })
    .selectOption("8");
  await expect(page.locator(".remote-footer")).toContainText("0.117 MHz span");
  const count = commands.filter((x) => x.startsWith("SET mod")).length;
  await page
    .getByRole("textbox", { name: "Remote channel MHz", exact: true })
    .fill("100");
  await page.getByRole("button", { name: "Tune", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("fit within");
  expect(commands.filter((x) => x.startsWith("SET mod")).length).toBe(count);
  await page
    .getByRole("textbox", { name: "Remote channel MHz", exact: true })
    .fill("7.1");
  await page
    .getByRole("combobox", { name: "Remote mode", exact: true })
    .selectOption("cw");
  await page.getByRole("button", { name: "Tune", exact: true }).click();
  await expect
    .poll(() => commands)
    .toContain("SET mod=cw low_cut=300 high_cut=1100 freq=7099.300");
  await page.getByRole("tab", { name: /Receiver/ }).click();
  await expect.poll(() => closed.length).toBe(2);
  await expect(page.getByRole("combobox", { name: /^Mode/ })).toHaveValue(
    "WBFM",
  );
});
test("KiwiSDR narrow controls, protocol changes and remembered URL never restart reception", async ({
  page,
}) => {
  const { closed } = await receiver(page);
  await expect(page.locator(".remote-header-status")).toContainText(
    "connected",
  );
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(
    page.getByRole("combobox", { name: "Waterfall zoom", exact: true }),
  ).toBeEnabled();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await page.getByRole("button", { name: "Listen", exact: true }).click();
  await page
    .getByRole("combobox", { name: "Remote receiver type", exact: true })
    .selectOption("openwebrx");
  await expect.poll(() => closed.length).toBe(2);
  await expect(
    page.getByRole("heading", { name: "OpenWebRX", exact: true }),
  ).toBeVisible();
  await page
    .getByRole("combobox", { name: "Remote receiver type", exact: true })
    .selectOption("kiwi");
  await expect(
    page.getByRole("textbox", { name: "Receiver website", exact: true }),
  ).toHaveValue("https://kiwi.example/");
  await expect(page.locator(".remote-header-status")).toContainText(
    "disconnected",
  );
  await page.reload();
  await page
    .getByRole("combobox", { name: "Signal source", exact: true })
    .selectOption("remote");
  await page
    .getByRole("combobox", { name: "Remote receiver type", exact: true })
    .selectOption("kiwi");
  await expect(
    page.getByRole("textbox", { name: "Receiver website", exact: true }),
  ).toHaveValue("https://kiwi.example/");
  await expect(
    page.getByRole("button", { name: "Listen", exact: true }),
  ).toBeDisabled();
  await expect(page.locator(".remote-header-status")).toContainText(
    "disconnected",
  );
});
test("KiwiSDR restricted access closes without probing passwords or opening a second stream", async ({
  page,
}) => {
  const { commands, urls } = await receiver(page, true);
  await expect(page.locator(".remote-message")).toContainText(
    "access approval",
  );
  await expect(
    page.getByRole("button", { name: "Listen", exact: true }),
  ).toBeDisabled();
  expect(urls).toHaveLength(1);
  expect(commands).toEqual(["SET auth t=kiwi p="]);
  await expect(
    page.getByRole("link", { name: "Open receiver website ↗", exact: true }),
  ).toHaveAttribute("href", "https://kiwi.example/");
});

type BenchmarkUpdate = {
  type: "progress" | "result" | "error";
  message: string;
  stats?: unknown;
};

const output = document.querySelector<HTMLPreElement>("#output")!;
const start = document.querySelector<HTMLButtonElement>("#start")!;
const grant = document.querySelector<HTMLButtonElement>("#grant")!;
const duration = document.querySelector<HTMLInputElement>("#duration")!;
const slots = document.querySelector<HTMLInputElement>("#slots")!;

function write(update: BenchmarkUpdate): void {
  output.textContent += `${new Date().toISOString()} ${update.type}: ${update.message}`
    + `${update.stats ? ` ${JSON.stringify(update.stats)}` : ""}\n`;
}

function setButtons(disabled: boolean): void {
  grant.disabled = disabled;
  start.disabled = disabled;
}

function launch(serialNumber: string | null): void {
  setButtons(true);
  output.textContent = "";
  const worker = new Worker(new URL("../workers/usrp-b205-webusb-benchmark.worker.ts", import.meta.url), { type: "module" });
  worker.onmessage = (event: MessageEvent<BenchmarkUpdate>) => {
    write(event.data);
    if (event.data.type === "result" || event.data.type === "error") {
      worker.terminate();
      setButtons(false);
    }
  };
  worker.onerror = (event) => {
    write({ type: "error", message: event.message });
    worker.terminate();
    setButtons(false);
  };
  worker.postMessage({
    type: "start",
    serialNumber,
    durationMs: Math.max(1_000, Number(duration.value) * 1_000),
    readSlots: Math.max(1, Math.min(256, Math.trunc(Number(slots.value)))),
  });
}

start.addEventListener("click", () => {
  const usb = navigator.usb;
  if (!usb?.getDevices) { write({ type: "error", message: "Authorized WebUSB lookup is unavailable." }); return; }
  void usb.getDevices().then((devices) => {
    const matches = devices.filter((device) => device.vendorId === 0x2500 && device.productId === 0x0022);
    if (matches.length !== 1) throw new Error(`Expected one authorized 2500:0022 device; found ${matches.length}.`);
    launch(matches[0]!.serialNumber ?? null);
  }).catch((error: unknown) => write({ type: "error", message: String(error) }));
});

grant.addEventListener("click", () => {
  const usb = navigator.usb;
  if (!usb) { write({ type: "error", message: "WebUSB is unavailable." }); return; }
  // Keep requestDevice directly on the click stack. The worker retrieves the
  // resulting authorization with getDevices() and becomes the sole I/O owner.
  void usb.requestDevice({ filters: [{ vendorId: 0x2500, productId: 0x0022 }] }).then(
    (device) => launch(device.serialNumber ?? null),
    (error: unknown) => write({ type: "error", message: String(error) }),
  );
});

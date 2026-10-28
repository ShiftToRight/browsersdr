import type {
  ReceiverBackend,
  ReceiverStartOptions,
} from "./receiverController";

/** Defer optional device implementation while keeping requestDevice in the
 * caller's user gesture. A cancelled chooser can never open a late device. */
export function lazyUsbBackend(
  create: () => Promise<ReceiverBackend>,
  filter: { vendorId: number; productId: number },
  usb?: USB,
): ReceiverBackend {
  let backend: ReceiverBackend | undefined,
    loading: Promise<ReceiverBackend> | undefined;
  let epoch = 0,
    closed = false;
  const load = () =>
    (loading ??= create().then((value) => {
      backend = value;
      return value;
    }));
  const connectGranted = async (
    options: ReceiverStartOptions,
    device: USBDevice,
    token = epoch,
  ) => {
    if (closed || epoch !== token)
      throw new DOMException("USB connection cancelled", "AbortError");
    const value = await load();
    if (closed || epoch !== token)
      throw new DOMException("USB connection cancelled", "AbortError");
    if (!value.connectGranted)
      throw new Error("Receiver cannot open an authorized USB device.");
    return value.connectGranted(options, device);
  };
  const facade = {
    connect(options: ReceiverStartOptions) {
      const bus = usb ?? navigator.usb;
      if (!bus)
        return Promise.reject(
          new Error("This browser does not support WebUSB."),
        );
      const token = epoch;
      // Do not import the driver or await anything before invoking permission.
      const permission = bus.requestDevice({ filters: [filter] });
      return permission.then((device) =>
        connectGranted(options, device, token),
      );
    },
    connectGranted,
    start(options: ReceiverStartOptions, generation?: number) {
      if (!backend)
        return Promise.reject(
          new Error("Connect the receiver before starting reception."),
        );
      return backend.start(options, generation);
    },
    async stop() {
      ++epoch;
      await loading?.then((value) => value.stop());
    },
    async disconnect() {
      closed = true;
      ++epoch;
      await loading?.then((value) => value.disconnect?.() ?? value.stop());
    },
    setVolume(volume: number) {
      backend?.setVolume(volume);
    },
  };
  return new Proxy(facade as ReceiverBackend, {
    get(target, property, receiver) {
      if (Reflect.has(target, property))
        return Reflect.get(target, property, receiver);
      const value: unknown = backend
        ? Reflect.get(backend, property, backend)
        : undefined;
      return typeof value === "function" ? value.bind(backend) : value;
    },
  });
}

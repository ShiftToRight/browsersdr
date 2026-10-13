import { FakeHackrfUsb, usbView } from "./hackrfUsbFixture";

/** Stateful One model derived from pinned official firmware, not the client.
 * Inherits only descriptor/lifecycle/bulk scheduling helpers from the Pro fixture.
 * No Pro control handler is invoked. This is software evidence, not RF hardware. */
export class FakeHackrfOneUsb extends FakeHackrfUsb {
  constructor(api = 0x0110) { super(api); }
  boardId = 2;
  revision = 0x81;
  platform = 2;
  firmware = "v2026.01.3";
  appliedRate = 0;
  appliedFilter = 0;
  appliedFrequency = 0;
  pendingRate = 9_600_000;
  pendingFilter = 7_000_000;
  pendingFrequency = 100_000_000;
  gain = { lna: 16, vga: 12 };
  appliedGain = { lna: 0, vga: 0 };
  private cachedFrequency = -1;
  override async controlTransferIn(setup: USBControlTransferParameters, length: number): Promise<USBInTransferResult> {
    this.calls.push({ direction: "in", setup, length, bytes: [] });
    const override = this.inOverride?.(setup, length); if (override) return override;
    const stall: USBInTransferResult = { status: "stall" };
    if (setup.requestType !== "vendor" || setup.recipient !== "device" || setup.value !== 0) return stall;
    const sizes: Record<number, number> = { 14: 1, 15: 32, 18: 24, 19: 1, 20: 1, 41: 40, 45: 1, 46: 4 };
    if (sizes[setup.request] !== length || (![19, 20].includes(setup.request) && setup.index !== 0)) return stall;
    let bytes: Uint8Array;
    switch (setup.request) {
      case 14: bytes = Uint8Array.of(this.boardId); break;
      case 15: bytes = new TextEncoder().encode(this.firmware); break;
      case 18: bytes = new Uint8Array(24); new DataView(bytes.buffer).setUint32(8, 0x01020304, true); break;
      case 45: bytes = Uint8Array.of(this.revision); break;
      case 46: bytes = new Uint8Array(4); new DataView(bytes.buffer).setUint32(0, this.platform, false); break;
      case 19:
        if (this.radio.get(0) === 1n && ![0, 8, 16, 24, 32, 40].includes(setup.index)) { bytes = Uint8Array.of(254); break; }
        this.gain.lna = setup.index; if (this.radio.get(0) === 1n) this.appliedGain.lna = setup.index;
        bytes = Uint8Array.of(1); break;
      case 20:
        if (this.radio.get(0) === 1n && (setup.index > 62 || setup.index % 2)) { bytes = Uint8Array.of(254); break; }
        this.gain.vga = setup.index; if (this.radio.get(0) === 1n) this.appliedGain.vga = setup.index;
        bytes = Uint8Array.of(1); break;
      case 41:
        bytes = new Uint8Array(40);
        new DataView(bytes.buffer).setUint32(0, this.radio.get(0) === 1n ? 2 : 0, true);
        new DataView(bytes.buffer).setUint32(4, this.radio.get(0) === 1n ? 2 : 0, true); break;
      default: return stall;
    }
    return { status: "ok", data: usbView(bytes) };
  }
  override async controlTransferOut(setup: USBControlTransferParameters, data?: BufferSource): Promise<USBOutTransferResult> {
    const bytes = data ? ArrayBuffer.isView(data) ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength) : new Uint8Array(data) : new Uint8Array();
    this.calls.push({ direction: "out", setup, length: bytes.length, bytes: [...bytes] });
    const override = this.outOverride?.(setup, bytes); if (override) return override;
    const stall: USBOutTransferResult = { status: "stall", bytesWritten: 0 };
    if (setup.requestType !== "vendor" || setup.recipient !== "device") return stall;
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const running = this.radio.get(0) === 1n;
    switch (setup.request) {
      case 6:
        if (bytes.length !== 8 || setup.value || setup.index || view.getUint32(4, true) !== 1) return stall;
        this.pendingRate = view.getUint32(0, true); if (running) this.appliedRate = this.pendingRate; break;
      case 7:
        if (bytes.length) return stall;
        this.pendingFilter = setup.value + setup.index * 65536;
        if (![1_750_000, 2_500_000, 3_500_000, 5_000_000, 5_500_000, 6_000_000, 7_000_000, 8_000_000].includes(this.pendingFilter)) return stall;
        if (running) this.appliedFilter = this.pendingFilter; break;
      case 16:
        if (bytes.length !== 8 || setup.value || setup.index) return stall;
        this.pendingFrequency = view.getUint32(0, true) * 1_000_000 + view.getUint32(4, true);
        if (running && this.pendingFrequency !== this.cachedFrequency) {
          this.cachedFrequency = this.pendingFrequency; this.appliedFrequency = this.pendingFrequency;
        } break;
      case 1:
        if (bytes.length || setup.index || ![0, 1].includes(setup.value)) return stall;
        this.radio.set(0, BigInt(setup.value));
        if (setup.value === 1) {
          this.appliedRate = this.pendingRate; this.appliedFilter = this.pendingFilter; this.appliedGain = { ...this.gain };
          if (this.pendingFrequency !== this.cachedFrequency) { this.cachedFrequency = this.pendingFrequency; this.appliedFrequency = this.pendingFrequency; }
        } else this.appliedFrequency = 0; // expose cached-frequency restart hazards
        break;
      case 17:
        if (bytes.length || setup.index || ![0, 1].includes(setup.value)) return stall; break;
      case 23: case 29:
        if (bytes.length || setup.index || setup.value !== 0) return stall; break;
      case 48:
        if (bytes.length || setup.index || setup.value !== 0x36) return stall; break;
      default: return stall; // includes Pro FPGA/image/radio-register commands
    }
    return { status: "ok", bytesWritten: bytes.length };
  }
}

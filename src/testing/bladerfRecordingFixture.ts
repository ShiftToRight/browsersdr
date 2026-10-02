import { defaultModeSettings } from "../radio/receiverConfig";
import { FakeBladeRfUsb } from "./bladerfUsbFixture";
import { BladeRfProtocol } from "../radio/bladerfProtocol";
import { bladeRfSc16RecordingFormat } from "../radio/bladerfRecording";
import { IqRecorder } from "../radio/iqRecording";
import type { SourceSessionMetadata } from "../radio/types";
import type { BladeRfMicroModel } from "../radio/bladerfModels";
import type { BladeRfSampleRateHz } from "../radio/sourceCapabilities";

export async function bladeRfRecordingFixture(
  bytes = Uint8Array.of(0, 248, 255, 7, 0, 252, 0, 4),
  rate: BladeRfSampleRateHz = 2_400_000,
  model: BladeRfMicroModel = "xA4",
  firmwareMinor = 5,
  rateOffset = 0,
) {
  const usb = new FakeBladeRfUsb();
  usb.model = model;
  usb.firmware = { major: 2, minor: firmwareMinor };
  usb.fpga =
    firmwareMinor === 4
      ? { major: 0, minor: 15, patch: 3 }
      : { major: 0, minor: 16, patch: 0 };
  usb.sampleRateReadbackOffset = rateOffset;
  usb.frequencyReadbackOffset = 10;
  await usb.open();
  await usb.selectConfiguration(1);
  await usb.claimInterface(0);
  const protocol = new BladeRfProtocol(usb);
  await protocol.open();
  const details = await protocol.configure({
    centerFrequencyHz: 100_000_000,
    sampleRateHz: rate,
    bandwidthHz: rate,
  });
  await usb.close();
  const format = bladeRfSc16RecordingFormat(details);
  const session: SourceSessionMetadata = {
    source: "bladerf",
    sessionGeneration: 1,
    requestedSampleRateHz: rate,
    actualSampleRateHz: details.acceptedSampleRateHz,
    hardwareCenterFrequencyHz: details.acceptedCenterFrequencyHz,
    selectedChannelFrequencyHz: 100_000_000,
    mode: "OFF",
    channelBandwidthHz: defaultModeSettings("OFF").bandwidthHz,
    squelch: defaultModeSettings("OFF").squelch,
    gainDb: null,
    sampleFormat: "planar-f32-iq-normalized",
    bladerf: details,
  };
  const makeRecorder = (maxBytes?: number) =>
    new IqRecorder(
      session,
      "2026-09-30T00:00:00.000Z",
      maxBytes,
      "Simulated USB; no hardware acceptance.",
      undefined,
      format,
    );
  const recorder = makeRecorder();
  recorder.appendBladeRfSc16(bytes);
  return {
    recording: recorder.finish(),
    details,
    session,
    format,
    makeRecorder,
  };
}

import { HackrfTransport } from "../radio/hackrfTransport";
import { FakeHackrfUsb } from "./hackrfUsbFixture";
import { DEFAULT_HACKRF_RX_SETTINGS, type HackrfSampleRateHz } from "../radio/sourceCapabilities";
import { IqRecorder } from "../radio/iqRecording";
import { hackrfRecordingFormat } from "../radio/ci8Recording";
import type { HackrfSourceSessionMetadata } from "../radio/types";

export async function hackrfRecordingFixture(bytes = Uint8Array.of(128, 127, 255, 0, 0, 255, 127, 128), rate: HackrfSampleRateHz = 1_024_000, api = 0x0113) {
  const transport = new HackrfTransport(); await transport.open(new FakeHackrfUsb(api));
  const configured = await transport.configure({ generation: 1, centerFrequencyHz: 4_300_000_001, sampleRateHz: rate, settings: DEFAULT_HACKRF_RX_SETTINGS });
  await transport.close();
  const session: HackrfSourceSessionMetadata = { source: "hackrf", sessionGeneration: 1, requestedSampleRateHz: rate, actualSampleRateHz: rate,
    hardwareCenterFrequencyHz: configured.hardwareCenterFrequencyHz, selectedChannelFrequencyHz: configured.hardwareCenterFrequencyHz,
    mode: "AM", channelBandwidthHz: 15_000, squelch: 0, gainDb: null, sampleFormat: "planar-f32-iq-normalized", hackrf: configured.details };
  const makeRecorder = (capacity = 32 * 1024 * 1024) => new IqRecorder(session, "2026-09-24T10:00:00.000Z", capacity, "Injected USB fixture; not a hardware observation.", undefined, hackrfRecordingFormat(session.hackrf));
  const recorder = makeRecorder(); recorder.appendCi8(bytes);
  return { session, configured, recording: recorder.finish(), makeRecorder };
}

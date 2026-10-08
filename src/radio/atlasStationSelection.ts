import type { AtlasStation } from "./atlasStations";
import type { ReceptionCandidate } from "./receptionEvidence";
import type { ReceiverController } from "./receiverController";
import {
  defaultModeSettings,
  normalizeModeSettings,
  type ReceiverModeSettings,
} from "./receiverConfig";
import {
  validateSourceConfiguration,
  validateSourceRoute,
  type SourceConfiguration,
} from "./sourceCapabilities";

export function atlasReferenceMode(
  format: string | null,
): ReceptionCandidate["mode"] | undefined {
  switch (format?.trim().toUpperCase()) {
    case "FM":
    case "WBFM":
    case "WFM":
      return "WBFM";
    case "AM":
      return "AM";
    case "NBFM":
    case "NFM":
      return "NBFM";
    default:
      return undefined;
  }
}
export function atlasReceptionCandidate(
  station: AtlasStation,
  transmissionId: string,
  manualMode?: ReceptionCandidate["mode"],
): ReceptionCandidate {
  const reference = station.transmissions.find((t) => t.id === transmissionId);
  if (!reference)
    throw new Error("Choose a current transmission belonging to this station.");
  const mode = atlasReferenceMode(reference.broadcast_format) ?? manualMode;
  if (!mode || !["WBFM", "AM", "NBFM"].includes(mode))
    throw new Error(
      "Choose WBFM, AM or NBFM explicitly for this reference format.",
    );
  return {
    station_id: station.id,
    station_name: station.name.slice(0, 300),
    transmission_id: reference.id,
    frequency_hz: reference.frequency_hz,
    bandwidth_hz:
      reference.bandwidth_hz ??
      (mode === "WBFM" ? 200000 : mode === "AM" ? 10000 : 12500),
    mode,
  };
}
/** No connection or Start calls. Existing controller transitions own accepted hardware changes. */
export async function applyReceptionCandidate(
  controller: ReceiverController,
  candidate: ReceptionCandidate,
  configuration: SourceConfiguration,
): Promise<{
  candidate: ReceptionCandidate;
  settings: ReceiverModeSettings;
  frequencyHz: number;
}> {
  const before = controller.getSnapshot(),
    source = configuration.source ?? "rtl-sdr";
  if (
    before.cleanupRequired ||
    !["idle", "connected", "running", "error"].includes(before.lifecycle) ||
    controller.getRecordingStatus()
  )
    throw new Error(
      "Finish the receiver operation or recording before selecting a station.",
    );
  if (source === "replay")
    throw new Error(
      "Station selection is unavailable during replay. Select a live source or the demo.",
    );
  if (
    !Number.isFinite(candidate.frequency_hz) ||
    candidate.frequency_hz <= 0 ||
    candidate.frequency_hz > 1e12 ||
    !Number.isFinite(candidate.bandwidth_hz) ||
    candidate.bandwidth_hz <= 0 ||
    candidate.bandwidth_hz > 1e12 ||
    !["WBFM", "AM", "NBFM"].includes(candidate.mode)
  )
    throw new Error("Invalid station frequency, bandwidth or receive mode.");
  const settings = normalizeModeSettings({
    ...defaultModeSettings(candidate.mode),
    squelch: configuration.modeSettings?.squelch ?? 0,
    bandwidthHz: candidate.bandwidth_hz,
  });
  validateSourceConfiguration({
    ...configuration,
    channelFrequencyHz: candidate.frequency_hz,
    modeSettings: settings,
  });
  if (before.lifecycle === "running") {
    const old = before.session;
    if (!old || old.source !== source)
      throw new Error("The receiver source changed. Select the station again.");
    validateSourceRoute(
      source,
      settings,
      old.actualSampleRateHz,
      candidate.frequency_hz,
    );
    // Validate the intermediate profile before touching the live receiver.
    validateSourceRoute(
      source,
      settings,
      old.actualSampleRateHz,
      old.selectedChannelFrequencyHz,
    );
    // Reject the complete proposed window before a mode transition can change
    // reception. This uses the same preflight as manual tuning and Favorites.
    controller.validateTune(candidate.frequency_hz, {}, settings);
    if (
      old.mode !== settings.mode ||
      old.channelBandwidthHz !== settings.bandwidthHz
    ) {
      const generation = before.sessionGeneration;
      await controller.configureMode(settings);
      const accepted = controller.getSnapshot();
      if (
        accepted.lifecycle !== "running" ||
        accepted.sessionGeneration === generation ||
        accepted.session?.mode !== settings.mode ||
        accepted.session.channelBandwidthHz !== settings.bandwidthHz
      )
        throw new Error(
          accepted.message || "The receiver rejected the station profile.",
        );
    }
    if (
      controller.getSnapshot().session?.selectedChannelFrequencyHz !==
      candidate.frequency_hz
    ) {
      const generation = controller.getSnapshot().sessionGeneration;
      await controller.tune(candidate.frequency_hz);
      const accepted = controller.getSnapshot();
      if (
        accepted.lifecycle !== "running" ||
        accepted.sessionGeneration === generation ||
        accepted.session?.source !== source ||
        accepted.session.selectedChannelFrequencyHz !== candidate.frequency_hz
      )
        throw new Error(
          accepted.message || "The receiver rejected the station frequency.",
        );
    }
    const accepted = controller.getSnapshot();
    if (
      accepted.lifecycle !== "running" ||
      accepted.session?.mode !== settings.mode ||
      accepted.session.channelBandwidthHz !== settings.bandwidthHz
    )
      throw new Error(
        "Receiver configuration changed. Select the station again.",
      );
  }
  return {
    candidate: { ...candidate },
    settings,
    frequencyHz: candidate.frequency_hz,
  };
}

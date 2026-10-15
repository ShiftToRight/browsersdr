import { validateBookmark, type Bookmark } from "./bookmarks";
import type { ReceiverController } from "./receiverController";
import { compatibleSourceRate } from "./sourcePreferences";
import {
  validateSourceConfiguration,
  validateSourceRoute,
  type SourceConfiguration,
} from "./sourceCapabilities";

/** Validate the whole proposed configuration before any receiver mutation. Never connects or starts. */
export async function applyBookmark(
  controller: ReceiverController,
  value: Bookmark,
  configuration: SourceConfiguration,
) {
  const bookmark = validateBookmark(value),
    source = configuration.source ?? "rtl-sdr";
  const before = controller.getSnapshot();
  if (source === "replay")
    throw new Error("Choose a live source or the demo to recall a favorite.");
  if (
    before.cleanupRequired ||
    !["idle", "connected", "running", "error"].includes(before.lifecycle) ||
    controller.getRecordingStatus()
  )
    throw new Error(
      "Finish the receiver operation or recording before recalling a favorite.",
    );
  const running = before.lifecycle === "running";
  const sampleRateHz = running
    ? before.session!.actualSampleRateHz
    : compatibleSourceRate(
        source,
        bookmark.settings.mode,
        configuration.sampleRateHz ?? 1_024_000,
      );
  if (sampleRateHz === undefined)
    throw new Error("This favorite needs a compatible source and sample rate.");
  if (running) {
    if (before.session?.source !== source)
      throw new Error("The receiver source changed. Recall again.");
    try {
      validateSourceRoute(
        source,
        bookmark.settings,
        sampleRateHz,
        bookmark.frequencyHz,
      );
      validateSourceRoute(
        source,
        bookmark.settings,
        sampleRateHz,
        before.session.selectedChannelFrequencyHz,
      );
    } catch (error) {
      throw new Error(
        `${error instanceof Error ? error.message : "Incompatible receiver configuration."} Stop reception before recalling this favorite.`,
        { cause: error },
      );
    }
    // Follow-channel and hardware-window constraints must pass before applying the mode.
    controller.validateTune(bookmark.frequencyHz, {}, bookmark.settings);
  } else
    validateSourceConfiguration({
      ...configuration,
      hackrfIdentity: before.session?.hackrf?.capabilities.identity,
      sampleRateHz,
      channelFrequencyHz: bookmark.frequencyHz,
      modeSettings: bookmark.settings,
    });
  if (running) {
    await controller.configureMode(bookmark.settings);
    let accepted = controller.getSnapshot();
    if (
      accepted.lifecycle !== "running" ||
      accepted.sessionGeneration === before.sessionGeneration ||
      accepted.session?.source !== source ||
      accepted.session.mode !== bookmark.settings.mode ||
      accepted.session.channelBandwidthHz !== bookmark.settings.bandwidthHz ||
      accepted.session.squelch !== bookmark.settings.squelch ||
      ((bookmark.settings.mode === "CW" || bookmark.settings.mode === "CW-TEXT") &&
        accepted.session.beatToneHz !== bookmark.settings.beatToneHz) ||
      (bookmark.settings.mode === "SRD" &&
        JSON.stringify(accepted.session.srd) !==
          JSON.stringify(bookmark.settings.srd)) ||
      (bookmark.settings.textModem !== undefined && JSON.stringify(accepted.session.textModem) !== JSON.stringify(bookmark.settings.textModem))
    )
      throw new Error(
        accepted.message || "Receiver rejected the favorite settings.",
      );
    if (accepted.session.selectedChannelFrequencyHz !== bookmark.frequencyHz)
      await controller.tune(bookmark.frequencyHz);
    accepted = controller.getSnapshot();
    if (
      accepted.lifecycle !== "running" ||
      accepted.session?.source !== source ||
      accepted.session.mode !== bookmark.settings.mode ||
      accepted.session.selectedChannelFrequencyHz !== bookmark.frequencyHz
    )
      throw new Error(
        accepted.message || "Receiver rejected the favorite frequency.",
      );
  }
  return { bookmark, sampleRateHz };
}

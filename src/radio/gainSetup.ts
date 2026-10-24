import type { ReceiverController } from "./receiverController";
import type { InputLevel } from "../dsp/inputClipping";
import { monitorWait } from "./monitorRunner";

/** User-triggered headroom setup for a declared continuous signal. This does
 * not optimize station SNR and never changes RF amplifier or antenna power. */
export async function runGainSetup(
  controller: ReceiverController,
  getLevel: () => InputLevel | undefined,
  signal: AbortSignal,
  message: (text: string) => void,
  wait = monitorWait,
) {
  const initial = controller.getSnapshot();
  if (
    initial.lifecycle !== "running" ||
    !initial.session ||
    !["rtl-sdr", "hackrf"].includes(initial.session.source) ||
    controller.getRecordingStatus()
  )
    throw new Error(
      "Gain setup requires running RTL/HackRF reception with no active I/Q capture.",
    );
  if (initial.session.rtlInput?.directSampling === "q")
    throw new Error(
      "Guided tuner gain is unavailable in direct sampling. Check the HF antenna and filtering manually.",
    );
  const generation = initial.sessionGeneration,
    source = initial.session.source;
  let expected = JSON.stringify([
    initial.session.gainDb,
    initial.session.hackrf?.captureSettings,
  ]);
  let settledAfter = performance.now() + 120;
  for (let step = 0; step < 8; step++) {
    await wait(700, signal);
    const current = controller.getSnapshot(),
      session = current.session;
    if (
      signal.aborted ||
      current.lifecycle !== "running" ||
      current.sessionGeneration !== generation ||
      session?.source !== source ||
      JSON.stringify([session.gainDb, session.hackrf?.captureSettings]) !==
        expected
    )
      throw new DOMException(
        "Gain setup cancelled after a receiver/manual settings change.",
        "AbortError",
      );
    const level = getLevel();
    if (!level || level.observedAtMs < settledAfter)
      throw new Error(
        "No fresh settled raw input level. Check sample delivery before adjusting gain.",
      );
    const direction =
      level.clippedFraction >= 0.001 || level.peakDb > -1 || level.rmsDb > -10
        ? -1
        : level.rmsDb < -30
          ? 1
          : 0;
    if (!direction) {
      message(
        "Input headroom is in range. Verify the desired signal or decoder output; strong unrelated signals affect this reading.",
      );
      return;
    }
    message(
      `Gain setup ${step + 1}/8 · raw RMS ${level.rmsDb.toFixed(1)} dB relative · ${direction < 0 ? "reducing" : "increasing"} gain`,
    );
    if (source === "rtl-sdr") {
      const previous = session.gainDb ?? 25,
        next = Math.max(0, Math.min(49.6, previous + direction * 4));
      if (next === previous) {
        message(
          "Gain limit reached. Check the antenna, filtering and selected signal.",
        );
        return;
      }
      await controller.setGain(next);
      if (controller.getSnapshot().session?.gainDb !== next)
        throw new Error("Gain request was not retained; setup stopped.");
    } else {
      const old = session.hackrf!.captureSettings,
        next = Math.max(0, Math.min(62, old.rxVgaGainDb + direction * 4));
      if (next === old.rxVgaGainDb) {
        message("VGA limit reached. Review LNA and signal quality manually.");
        return;
      }
      await controller.configureHardware({
        kind: "hackrf",
        rxLnaGainCode: old.rxLnaGainCode,
        rxVgaGainDb: next,
        rfAmplifierEnabled: old.rfAmplifierEnabled,
        antennaPowerEnabled: old.antennaPowerEnabled,
      });
      const accepted =
        controller.getSnapshot().session?.hackrf?.captureSettings;
      if (
        !accepted ||
        accepted.rxVgaGainDb !== next ||
        accepted.rxLnaGainCode !== old.rxLnaGainCode ||
        accepted.antennaPowerEnabled !== old.antennaPowerEnabled ||
        accepted.rfAmplifierEnabled !== old.rfAmplifierEnabled
      )
        throw new Error(
          "RX settings changed during gain setup; setup stopped.",
        );
    }
    settledAfter = performance.now() + 120;
    expected = JSON.stringify([
      controller.getSnapshot().session?.gainDb,
      controller.getSnapshot().session?.hackrf?.captureSettings,
    ]);
  }
  message(
    "Bounded gain setup completed. Verify decoded output and adjust manually if needed.",
  );
}

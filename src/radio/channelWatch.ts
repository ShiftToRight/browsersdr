import type { AnalysisPipeline } from "../dsp/analysisPipeline";
import type { ReceiverController } from "./receiverController";
import type { SourceSessionMetadata, SpectrumFrame } from "./types";
import type { ReceiverModeSettings } from "./receiverConfig";
import { normalizeModeSettings } from "./receiverConfig";
import { monitorWait } from "./monitorRunner";
import type { ActivityCapture } from "./activityCapture";

export interface WatchChannel {
  name: string;
  frequencyHz: number;
  settings: ReceiverModeSettings;
}
export interface WatchSettings {
  dwellMs: number;
  holdMs: number;
  thresholdDb: number;
  cooldownMs: number;
  listen: boolean;
}
export interface WatchEvent {
  source: SourceSessionMetadata["source"];
  mode: ReceiverModeSettings["mode"];
  centerFrequencyHz: number;
  sampleRateHz: number;
  kind: "new" | "returning" | "changed";
  name: string;
  frequencyHz: number;
  aboveNoiseDb: number;
  observedAt: string;
  generation: number;
}
export function watchLevel(
  frame: SpectrumFrame,
  frequencyHz: number,
  widthHz: number,
): number | undefined {
  const step = frame.sampleRateHz / frame.bins.length,
    lo = frame.centerFrequencyHz - frame.sampleRateHz / 2;
  const first = Math.max(0, Math.ceil((frequencyHz - widthHz / 2 - lo) / step)),
    last = Math.min(
      frame.bins.length - 1,
      Math.floor((frequencyHz + widthHz / 2 - lo) / step),
    );
  if (
    first > last ||
    frequencyHz - widthHz / 2 < lo ||
    frequencyHz + widthHz / 2 > lo + frame.sampleRateHz
  )
    return;
  let peak = -Infinity;
  const noise: number[] = [];
  for (let i = first; i <= last; i++)
    if (Number.isFinite(frame.bins[i])) peak = Math.max(peak, frame.bins[i]!);
  const stride = Math.max(1, Math.floor(frame.bins.length / 256));
  for (let i = 0; i < frame.bins.length; i += stride)
    if ((i < first || i > last) && Number.isFinite(frame.bins[i]))
      noise.push(frame.bins[i]!);
  noise.sort((a, b) => a - b);
  if (noise.length < 8 || !Number.isFinite(peak)) return;
  return peak - noise[Math.floor(noise.length / 2)]!;
}
export async function runChannelWatch(options: {
  controller: ReceiverController;
  pipeline: AnalysisPipeline;
  channels: WatchChannel[];
  settings: WatchSettings;
  signal: AbortSignal;
  volume: number;
  getVolume?: () => number;
  onVisit: (message: string) => void;
  onEvent: (event: WatchEvent) => void;
  capture?: ActivityCapture;
}) {
  const { controller, pipeline, signal, settings, capture } = options;
  const channels = options.channels.map((channel) => ({
    ...channel,
    settings: normalizeModeSettings(channel.settings),
  }));
  if (
    !channels.length ||
    channels.length > 64 ||
    channels.some(
      (c) =>
        !Number.isFinite(c.frequencyHz) ||
        c.frequencyHz <= 0 ||
        c.name.length > 120,
    )
  )
    throw new Error("Choose 1–64 valid watch channels.");
  if (
    !Number.isFinite(settings.dwellMs) ||
    settings.dwellMs < 250 ||
    settings.dwellMs > 30_000 ||
    !Number.isFinite(settings.holdMs) ||
    settings.holdMs < 0 ||
    settings.holdMs > 10_000 ||
    !Number.isFinite(settings.thresholdDb) ||
    settings.thresholdDb < 3 ||
    settings.thresholdDb > 60 ||
    !Number.isFinite(settings.cooldownMs) ||
    settings.cooldownMs < 1000 ||
    settings.cooldownMs > 3_600_000
  )
    throw new Error("Invalid watch dwell, hold, threshold or cooldown.");
  const original = controller.getSnapshot(),
    initial = original.session;
  if (
    original.lifecycle !== "running" ||
    !initial ||
    !["airspy", "rtl-sdr", "hackrf", "bladerf", "usrp-b205"].includes(initial.source) ||
    controller.getRecordingStatus()
  )
    throw new Error(
      "Watch channels requires a running local receiver with no active recording.",
    );
  if (original.secondaryVfo)
    throw new Error(
      "Disable VFO B before watching channels that may move the receiver.",
    );
  let owned = original.sessionGeneration;
  const check = () => {
    const current = controller.getSnapshot();
    if (
      signal.aborted ||
      current.lifecycle !== "running" ||
      current.sessionGeneration !== owned ||
      current.session?.source !== initial.source
    )
      throw new DOMException(
        "Channel watch stopped or receiver ownership changed.",
        "AbortError",
      );
  };
  const command = async (action: () => Promise<unknown>) => {
    check();
    const task = action(),
      issued = controller.getSnapshot().sessionGeneration;
    await task;
    if (controller.getSnapshot().sessionGeneration !== issued)
      throw new DOMException(
        "Receiver ownership changed during a watch command.",
        "AbortError",
      );
    owned = issued;
    check();
  };
  const states = new Map<
    string,
    { ever: boolean; active: boolean; level: number; alertAt: number }
  >();
  const unsubscribe = capture
    ? controller.subscribeCaptureSamples(capture.observe)
    : () => undefined;
  const cancelCapture = () => capture?.reset();
  signal.addEventListener("abort", cancelCapture, { once: true });
  try {
    while (true) {
      for (const channel of channels) {
        check();
        await command(() => controller.configureMode(channel.settings));
        await command(() =>
          controller.tune(channel.frequencyHz, { autoRecenter: true }),
        );
        const session = controller.getSnapshot().session!;
        if (
          session.mode !== channel.settings.mode ||
          Math.abs(session.selectedChannelFrequencyHz - channel.frequencyHz) > 1
        )
          throw new Error("Watch channel configuration was rejected.");
        controller.setVolume(
          settings.listen ? (options.getVolume?.() ?? options.volume) : 0,
        );
        options.onVisit(
          `Watching ${channel.name} · ${(channel.frequencyHz / 1e6).toFixed(6)} MHz`,
        );
        await monitorWait(120, signal);
        check();
        let level: number | undefined;
        const stop = pipeline.subscribeMeasurements((frame) => {
          if (
            frame.sessionGeneration !== owned ||
            frame.centerFrequencyHz !== session.hardwareCenterFrequencyHz ||
            frame.missingSamplesBefore ||
            frame.droppedFramesBefore
          )
            return;
          const next = watchLevel(
            frame,
            channel.frequencyHz,
            channel.settings.bandwidthHz,
          );
          if (next !== undefined) level = Math.max(level ?? -Infinity, next);
        }, true);
        try {
          await monitorWait(settings.dwellMs, signal);
          check();
        } finally {
          stop();
        }
        if (level === undefined) {
          options.onVisit(`${channel.name}: no valid measured coverage`);
          continue;
        }
        const key = JSON.stringify([channel.frequencyHz, channel.settings]);
        const prior = states.get(key),
          active = level >= settings.thresholdDb - (prior?.active ? 3 : 0),
          now = Date.now();
        const kind = !prior?.ever
          ? "new"
          : !prior.active
            ? "returning"
            : Math.abs(level - prior.level) >= 6
              ? "changed"
              : undefined;
        states.set(key, {
          ever: (prior?.ever ?? false) || active,
          active,
          level,
          alertAt: prior?.alertAt ?? 0,
        });
        if (
          active &&
          kind &&
          (!prior?.alertAt || now - prior.alertAt >= settings.cooldownMs)
        ) {
          states.get(key)!.alertAt = now;
          options.onEvent({
            source: session.source,
            mode: channel.settings.mode,
            centerFrequencyHz: session.hardwareCenterFrequencyHz,
            sampleRateHz: session.actualSampleRateHz,
            kind,
            name: channel.name,
            frequencyHz: channel.frequencyHz,
            aboveNoiseDb: level,
            observedAt: new Date(now).toISOString(),
            generation: owned,
          });
          if (capture) {
            check();
            await capture.trigger();
            check();
          }
        }
        // Hard cap prevents a busy channel from starving later targets.
        if (active && settings.holdMs) {
          await monitorWait(settings.holdMs, signal);
          check();
        }
      }
    }
  } finally {
    signal.removeEventListener("abort", cancelCapture);
    unsubscribe();
    capture?.reset();
    const current = controller.getSnapshot();
    if (
      current.lifecycle === "running" &&
      current.sessionGeneration === owned &&
      current.session?.source === initial.source
    ) {
      const restore = async (
        action: () => Promise<unknown>,
      ): Promise<boolean> => {
        const before = controller.getSnapshot();
        if (
          before.lifecycle !== "running" ||
          before.sessionGeneration !== owned ||
          before.session?.source !== initial.source
        )
          return false;
        const task = action(),
          issued = controller.getSnapshot().sessionGeneration;
        await task;
        const after = controller.getSnapshot();
        if (
          after.lifecycle !== "running" ||
          after.sessionGeneration !== issued ||
          after.session?.source !== initial.source
        )
          return false;
        owned = issued;
        return true;
      };
      const modeRestored = await restore(() =>
        controller.configureMode({
          mode: initial.mode,
          bandwidthHz: initial.channelBandwidthHz,
          squelch: initial.squelch,
          beatToneHz: initial.beatToneHz,
          srd: initial.srd,
          textModem: initial.textModem,
          pocsag: initial.pocsag,
        }),
      );
      if (
        modeRestored &&
        (await restore(() =>
          controller.scanTune(initial.hardwareCenterFrequencyHz),
        )) &&
        (await restore(() =>
          controller.tune(initial.selectedChannelFrequencyHz, {
            autoRecenter: false,
          }),
        ))
      )
        controller.setVolume(options.getVolume?.() ?? options.volume);
    }
  }
}

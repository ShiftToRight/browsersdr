import { useEffect, useState } from "react";
import { flushSync } from "react-dom";
import { planChannelTune } from "../radio/receiverConfig";
import {
  isWidebandRate,
  sourceCapabilities,
  validateSourceFrequency,
} from "../radio/sourceCapabilities";
import type { SourceSessionMetadata } from "../radio/types";
import { editableFrequencyMHz, formatFrequencyMHz } from "./frequencyFormat";
import { ActionButton } from "./ActionButton";

export function ReceiverTuningControl({
  session,
  configuredFrequencyHz,
  disabled,
  autoRecenter,
  onAutoRecenter,
  onTuneCenter,
  channelPending = false,
}: {
  session?: SourceSessionMetadata;
  configuredFrequencyHz: number;
  disabled: boolean;
  channelPending?: boolean;
  autoRecenter: boolean;
  onAutoRecenter: (enabled: boolean) => void;
  onTuneCenter: (frequencyHz: number) => Promise<string | undefined>;
}) {
  const centerHz = session?.hardwareCenterFrequencyHz ?? configuredFrequencyHz;
  const [draft, setDraft] = useState<string>();
  const [message, setMessage] = useState<string>();
  const [applying, setApplying] = useState(false);
  useEffect(() => {
    setDraft(undefined);
    setMessage(undefined);
  }, [centerHz, session?.source]);
  const value = draft ?? formatFrequencyMHz(centerHz);
  let requestedHz = value.trim() ? Number(value) * 1_000_000 : NaN;
  if (session && sourceCapabilities(session.source).frequency.integerHz)
    requestedHz = Math.round(requestedHz);
  const replay = session?.source === "replay";
  const busy = disabled || applying || channelPending || !session || replay;
  const busyReason = replay
    ? "The receiver center is fixed in a recording."
    : !session
      ? "Start reception to adjust the receiver center."
      : applying || disabled
        ? "Wait for reception to resume and any tuning or scan to finish."
        : channelPending
          ? "Apply or cancel the channel frequency edit first."
          : undefined;
  const requiresCenter =
    session &&
    ["hackrf", "bladerf", "usrp-b205"].includes(session.source) &&
    !isWidebandRate(session.actualSampleRateHz) &&
    ["DAB", "ADS-B"].includes(session.mode);
  let invalid: string | undefined;
  if (session && draft !== undefined) {
    try {
      validateSourceFrequency(
        session.source,
        requestedHz,
        ["hackrf", "bladerf", "usrp-b205"].includes(session.source)
          ? session.actualSampleRateHz
          : 0,
      );
      planChannelTune(
        centerHz,
        session.selectedChannelFrequencyHz,
        session.actualSampleRateHz,
        session.channelBandwidthHz,
        { centerFrequencyHz: requestedHz },
      );
      if (requiresCenter && requestedHz !== session.selectedChannelFrequencyHz)
        throw new Error(
          `${session.mode} requires the receiver center to match the channel at this sample rate.`,
        );
    } catch (error) {
      invalid =
        error instanceof Error
          ? error.message
          : "Enter a valid receiver center.";
    }
  }
  const pending =
    draft !== undefined && Math.round(requestedHz) !== Math.round(centerHz);
  const apply = async (frequencyHz: number) => {
    if (busy) return;
    setApplying(true);
    setMessage(undefined);
    try {
      const error = await onTuneCenter(frequencyHz);
      if (error) setMessage(error);
      else setDraft(undefined);
    } finally {
      setApplying(false);
    }
  };
  return (
    <div className="receiver-tuning" aria-label="Receiver window tuning">
      <div className="receiver-tuning-row">
        <label className="receiver-center-field">
          <span>Receiver center</span>
          <span className="unit-input">
            <input
              type="number"
              step="0.000001"
              value={value}
              title={`${centerHz.toLocaleString(undefined, { maximumFractionDigits: 3 })} Hz accepted receiver center`}
              aria-label="Receiver center"
              aria-describedby={
                replay
                  ? "receiver-center-help receiver-center-state"
                  : "receiver-center-state"
              }
              aria-invalid={Boolean(invalid)}
              disabled={busy}
              onFocus={(event) => {
                flushSync(() =>
                  setDraft(
                    (current) => current ?? editableFrequencyMHz(centerHz),
                  ),
                );
                event.currentTarget.select();
              }}
              onBlur={() => {
                if (Math.round(requestedHz) === Math.round(centerHz))
                  setDraft(undefined);
              }}
              onChange={(event) => {
                setDraft(event.currentTarget.value);
                setMessage(undefined);
              }}
              onKeyDown={(event) => {
                if (event.key === "Escape") {
                  setDraft(undefined);
                  setMessage(undefined);
                }
                if (event.key === "Enter" && pending && !invalid) {
                  event.preventDefault();
                  void apply(requestedHz);
                }
              }}
            />
            <span>MHz</span>
          </span>
        </label>
        <div className="receiver-tuning-right">
          <div className="receiver-tuning-actions">
            <ActionButton
              type="button"
              className="secondary toolbar-action"
              disabled={busy || !pending || Boolean(invalid)}
              disabledReason={
                busyReason ?? invalid ?? "Edit the receiver frequency first."
              }
              onClick={() => void apply(requestedHz)}
            >
              Set center
            </ActionButton>
            <label
              className="receiver-auto-center"
              title="Move the receiver only when the complete channel no longer fits in the usable RF window"
            >
              <input
                type="checkbox"
                checked={autoRecenter}
                disabled={disabled || applying || replay}
                onChange={(event) =>
                  onAutoRecenter(event.currentTarget.checked)
                }
              />
              <span>Auto re-center</span>
            </label>
            <ActionButton
              type="button"
              className="secondary toolbar-action"
              disabled={
                busy || session?.selectedChannelFrequencyHz === centerHz
              }
              disabledReason={
                busyReason ?? "The receiver is already centered on the channel."
              }
              onClick={() =>
                session && void apply(session.selectedChannelFrequencyHz)
              }
            >
              Center on channel
            </ActionButton>
          </div>
          {session && (
            <small className="receiver-offset">
              Channel offset{" "}
              {(session.selectedChannelFrequencyHz - centerHz) / 1_000 >= 0
                ? "+"
                : ""}
              {(
                (session.selectedChannelFrequencyHz - centerHz) /
                1_000
              ).toFixed(3)}{" "}
              kHz
            </small>
          )}
        </div>
      </div>
      {replay && (
        <small id="receiver-center-help">
          Capture center is fixed during replay
        </small>
      )}
      <small
        id="receiver-center-state"
        role="status"
        className={
          invalid || message ? "receiver-tuning-error" : "pending-change"
        }
      >
        {invalid ??
          message ??
          (applying
            ? "Applying receiver center…"
            : pending
              ? "Change pending · press Set center or Enter"
              : "")}
      </small>
    </div>
  );
}

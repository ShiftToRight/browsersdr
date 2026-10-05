import { useEffect, useMemo, useRef, useSyncExternalStore } from "react";
import type { AnalysisPipeline } from "../dsp/analysisPipeline";
import { CenterSignalAction } from "../radio/centerSignal";
import type { ReceiverController } from "../radio/receiverController";
import { ActionButton } from "./ActionButton";

export function CenterSignalControl({
  controller,
  analysis,
  disabled,
  contextKey,
  onAccepted,
  disabledReason,
}: {
  controller: ReceiverController;
  analysis: AnalysisPipeline;
  disabled: boolean;
  /** Includes pending input and analog settings which can change within a generation. */
  contextKey: string;
  onAccepted: (frequencyHz: number) => void;
  disabledReason?: string;
}) {
  const gate = useRef({ disabled, onAccepted });
  gate.current = { disabled, onAccepted };
  const action = useMemo(
    () =>
      new CenterSignalAction(
        controller,
        analysis,
        () => !gate.current.disabled,
        (frequency) => gate.current.onAccepted(frequency),
      ),
    [controller, analysis],
  );
  const state = useSyncExternalStore(action.subscribe, action.getSnapshot);
  useEffect(() => {
    action.start();
    return () => action.dispose();
  }, [action]);
  useEffect(() => {
    action.updateContext(contextKey, disabled);
  }, [action, contextKey, disabled]);
  return (
    <>
      <ActionButton
        type="button"
        className="secondary tune-button"
        icon="crosshair"
        disabledLabel={state.measuring ? "Measuring signal" : "Fine-tune signal"}
        disabled={disabled || state.measuring}
        disabledReason={
          state.measuring
            ? "Wait for the measurement to finish."
            : (disabledReason ??
              "Start AM or FM reception and apply any pending edits first.")
        }
        title={
          disabled
            ? "Requires running AM, NBFM or WBFM reception, no pending frequency edit, recording or scan."
            : "Measure the selected signal once and correct its frequency when clear."
        }
        onClick={() => {
          void action.center();
        }}
      >
        {state.measuring ? "Measuring…" : "Fine-tune signal"}
      </ActionButton>
      {state.undoAvailable && (
        <ActionButton
          type="button"
          className="secondary"
          icon="retry"
          disabled={disabled}
          disabledReason={
            disabledReason ??
            "Resume reception and apply any pending edits first."
          }
          onClick={() => {
            void action.undoCorrection();
          }}
        >
          Undo fine-tune
        </ActionButton>
      )}
      {state.message && (
        <small role="status" className="center-signal-status">
          {state.message}
        </small>
      )}
    </>
  );
}

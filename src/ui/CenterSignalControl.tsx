import { useEffect, useMemo, useRef, useSyncExternalStore } from "react";
import type { AnalysisPipeline } from "../dsp/analysisPipeline";
import { CenterSignalAction } from "../radio/centerSignal";
import type { ReceiverController } from "../radio/receiverController";

export function CenterSignalControl({
  controller,
  analysis,
  disabled,
  contextKey,
  onAccepted,
}: {
  controller: ReceiverController;
  analysis: AnalysisPipeline;
  disabled: boolean;
  /** Includes pending input and analog settings which can change within a generation. */
  contextKey: string;
  onAccepted: (frequencyHz: number) => void;
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
      <button
        type="button"
        className="secondary tune-button"
        disabled={disabled || state.measuring}
        title={
          disabled
            ? "Requires running AM, NBFM or WBFM reception, no pending frequency edit, recording or scan."
            : "Measure the selected signal once and correct its frequency when clear."
        }
        onClick={() => {
          void action.center();
        }}
      >
        {state.measuring ? "Measuring…" : "Center signal"}
      </button>
      {state.undoAvailable && (
        <button
          type="button"
          className="secondary"
          disabled={disabled}
          onClick={() => {
            void action.undoCorrection();
          }}
        >
          Undo center
        </button>
      )}
      {state.message && (
        <small role="status" className="center-signal-status">
          {state.message}
        </small>
      )}
    </>
  );
}

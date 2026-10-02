import type { AnalysisPipeline } from "../dsp/analysisPipeline";
import type { ReceiverController } from "./receiverController";
import type { SourceSessionMetadata } from "./types";

export interface CenterSignalState {
  measuring: boolean;
  message: string;
  undoAvailable: boolean;
}
function routeKey(session: SourceSessionMetadata): string {
  return [
    session.source,
    session.sessionGeneration,
    session.hardwareCenterFrequencyHz,
    session.selectedChannelFrequencyHz,
    session.actualSampleRateHz,
    session.mode,
    session.channelBandwidthHz,
  ].join(":");
}

/** Owns a single measurement and correction. Every continuation rechecks the
 * receiver and UI gate; tuning itself goes through the normal controller path. */
export class CenterSignalAction {
  private state: CenterSignalState = {
    measuring: false,
    message: "",
    undoAvailable: false,
  };
  private readonly listeners = new Set<() => void>();
  private operation = 0;
  private measurementRoute?: string;
  private undo?: { previousHz: number; expectedRoute: string };
  private unsubscribe?: () => void;
  private applyingTarget?: number;
  private contextKey?: string;
  constructor(
    private readonly controller: ReceiverController,
    private readonly analysis: Pick<
      AnalysisPipeline,
      "measureSignalCenter" | "cancelSignalCenter"
    >,
    private readonly allowed: () => boolean,
    private readonly accepted: (frequencyHz: number) => void,
  ) {}
  start(): void {
    this.unsubscribe ??= this.controller.subscribe(() => {
      const snapshot = this.controller.getSnapshot();
      const session = snapshot.session;
      if (this.state.measuring) {
        if (this.applyingTarget !== undefined) {
          if (
            !session ||
            session.selectedChannelFrequencyHz !== this.applyingTarget ||
            !["running", "tuning"].includes(snapshot.lifecycle)
          ) {
            const failure =
              snapshot.lifecycle === "error"
                ? `Center correction failed: ${snapshot.message}`
                : undefined;
            this.cancel();
            if (failure) this.publish({ message: failure });
          }
        } else if (
          !this.canAct() ||
          !session ||
          routeKey(session) !== this.measurementRoute
        )
          this.cancel();
      }
      if (
        this.undo &&
        (!session ||
          routeKey(session) !== this.undo.expectedRoute ||
          snapshot.lifecycle !== "running")
      ) {
        this.undo = undefined;
        this.publish({ undoAvailable: false });
      }
    });
  }
  updateContext(key: string, disabled: boolean): void {
    if (
      (this.contextKey !== undefined && this.contextKey !== key) ||
      (disabled && this.applyingTarget === undefined)
    )
      this.cancel();
    this.contextKey = key;
  }
  getSnapshot = (): CenterSignalState => this.state;
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };
  private publish(next: Partial<CenterSignalState>): void {
    this.state = { ...this.state, ...next };
    for (const listener of this.listeners) listener();
  }
  private canAct(): boolean {
    const snapshot = this.controller.getSnapshot();
    return (
      this.allowed() &&
      snapshot.lifecycle === "running" &&
      !!snapshot.session &&
      ["AM", "NBFM", "WBFM"].includes(snapshot.session.mode) &&
      !this.controller.getRecordingStatus()
    );
  }
  cancel(): void {
    if (!this.state.measuring) return;
    this.operation++;
    this.applyingTarget = undefined;
    this.analysis.cancelSignalCenter();
    if (this.state.measuring)
      this.publish({
        measuring: false,
        message: "Measurement cancelled after receiver settings changed.",
      });
  }
  dispose(): void {
    this.cancel();
    this.operation++;
    this.unsubscribe?.();
    this.unsubscribe = undefined;
  }
  async center(): Promise<void> {
    if (!this.canAct() || this.state.measuring) return;
    const session = { ...this.controller.getSnapshot().session! };
    const key = routeKey(session);
    const operation = ++this.operation;
    this.measurementRoute = key;
    const started = performance.now();
    this.undo = undefined;
    this.publish({
      measuring: true,
      message: "Measuring local signal…",
      undoAvailable: false,
    });
    try {
      const result = await this.analysis.measureSignalCenter(session);
      if (operation !== this.operation) return;
      if (result.kind === "failure") {
        this.publish({ measuring: false, message: result.message });
        return;
      }
      if (
        !this.canAct() ||
        routeKey(this.controller.getSnapshot().session!) !== key ||
        performance.now() - started > 3_000
      ) {
        this.publish({
          measuring: false,
          message:
            "Measurement expired after receiver settings changed. Try again.",
        });
        return;
      }
      if (
        result.kind !== "estimate" ||
        result.offsetHz === undefined ||
        result.toleranceHz === undefined
      ) {
        this.publish({ measuring: false, message: result.message });
        return;
      }
      if (Math.abs(result.offsetHz) <= result.toleranceHz) {
        this.publish({
          measuring: false,
          message: "Already centered within measurement tolerance.",
        });
        return;
      }
      const target = Math.round(
        session.selectedChannelFrequencyHz + result.offsetHz,
      );
      // Keep the operation busy through the expected tune transition. User
      // context changes still invalidate its completion callback.
      this.applyingTarget = target;
      this.publish({ message: "Applying measured correction…" });
      await this.controller.tune(target);
      if (operation !== this.operation) {
        const failed = this.controller.getSnapshot();
        if (failed.lifecycle === "error")
          this.publish({
            measuring: false,
            message: `Center correction failed: ${failed.message}`,
          });
        return;
      }
      const snapshot = this.controller.getSnapshot();
      if (
        snapshot.lifecycle !== "running" ||
        snapshot.session?.selectedChannelFrequencyHz !== target ||
        snapshot.sessionGeneration === session.sessionGeneration
      ) {
        this.applyingTarget = undefined;
        this.publish({
          measuring: false,
          message: `Center correction failed: ${snapshot.message}`,
        });
        return;
      }
      this.applyingTarget = undefined;
      this.undo = {
        previousHz: session.selectedChannelFrequencyHz,
        expectedRoute: routeKey(snapshot.session),
      };
      this.accepted(target);
      const offset = target - session.selectedChannelFrequencyHz;
      this.publish({
        measuring: false,
        message: `Corrected ${offset >= 0 ? "+" : ""}${Math.round(offset).toLocaleString()} Hz (estimated).`,
        undoAvailable: true,
      });
    } catch (error) {
      this.applyingTarget = undefined;
      if (operation === this.operation)
        this.publish({
          measuring: false,
          message: `Center signal failed: ${error instanceof Error ? error.message : String(error)}`,
        });
    }
  }
  async undoCorrection(): Promise<void> {
    const undo = this.undo;
    const session = this.controller.getSnapshot().session;
    if (
      !undo ||
      !this.canAct() ||
      !session ||
      routeKey(session) !== undo.expectedRoute
    )
      return;
    this.undo = undefined;
    this.applyingTarget = undo.previousHz;
    this.publish({
      undoAvailable: false,
      measuring: true,
      message: "Restoring previous frequency…",
    });
    const operation = ++this.operation;
    await this.controller.tune(undo.previousHz);
    if (operation !== this.operation) return;
    this.applyingTarget = undefined;
    const snapshot = this.controller.getSnapshot();
    if (
      snapshot.lifecycle === "running" &&
      snapshot.session?.selectedChannelFrequencyHz === undo.previousHz
    ) {
      this.accepted(undo.previousHz);
      this.publish({
        measuring: false,
        message: "Previous frequency restored.",
      });
    } else
      this.publish({
        measuring: false,
        message: `Undo failed: ${snapshot.message}`,
      });
  }
}

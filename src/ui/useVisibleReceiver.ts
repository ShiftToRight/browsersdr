import { useCallback, useSyncExternalStore } from "react";
import type { ReceiverController } from "../radio/receiverController";

function subscribeVisibility(listener: () => void) {
  document.addEventListener("visibilitychange", listener);
  return () => document.removeEventListener("visibilitychange", listener);
}
const isVisible = () => document.visibilityState !== "hidden";
const noSubscription = () => () => undefined;

/** Presentation only: acquisition and retained decoder results remain controller-owned. */
export function useVisibleReceiver(
  controller: ReceiverController,
  active: boolean,
) {
  const visible = useSyncExternalStore(subscribeVisibility, isVisible);
  const presenting = active && visible;
  const subscribe = useCallback(
    (listener: () => void) =>
      presenting ? controller.subscribe(listener) : noSubscription(),
    [controller, presenting],
  );
  const receiver = useSyncExternalStore(subscribe, controller.getSnapshot);
  return { receiver, presenting };
}

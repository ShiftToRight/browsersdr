import { useEffect, type RefObject } from "react";

/** Keep the native modal/focus boundary until its short exit motion finishes. */
export function useOverlayDialog(
  open: boolean,
  dialog: RefObject<HTMLDialogElement | null>,
  trigger: RefObject<HTMLButtonElement | null>,
  focusSelector: string,
) {
  useEffect(() => {
    const panel = dialog.current;
    if (!panel) return;
    let closing: ReturnType<typeof setTimeout> | undefined;
    const finish = () => {
      panel.close();
      delete panel.dataset.closing;
      if (trigger.current?.isConnected) trigger.current.focus();
    };
    if (open) {
      delete panel.dataset.closing;
      if (!panel.open) panel.showModal();
    } else if (panel.open) {
      if (window.matchMedia("(prefers-reduced-motion: reduce)").matches)
        finish();
      else {
        panel.dataset.closing = "true";
        // CSS exits in 140 ms; allow one frame before removing the top layer.
        closing = setTimeout(finish, 160);
      }
    }
    return () => clearTimeout(closing);
  }, [open, dialog, trigger]);
  useEffect(() => {
    if (open)
      dialog.current?.querySelector<HTMLElement>(focusSelector)?.focus();
  }, [open, dialog, focusSelector]);
}

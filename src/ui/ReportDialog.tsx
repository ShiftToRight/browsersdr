import { useLayoutEffect, useRef, type ReactNode } from "react";

/** Native modal semantics keep background controls inert and contain keyboard focus. */
export function ReportDialog({ children, labelledBy, onDismiss, className = "" }: {
  children: ReactNode;
  labelledBy: string;
  onDismiss: () => void;
  className?: string;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const dismiss = useRef(onDismiss);
  dismiss.current = onDismiss;
  useLayoutEffect(() => {
    const element = dialog.current!;
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : undefined;
    if (element.showModal) element.showModal();
    else element.setAttribute("open", "");
    const focus = () => element.querySelector<HTMLElement>("textarea, input, select, button")?.focus();
    focus();
    // A StrictMode close/reopen can trigger a late browser focus restoration.
    const frame = requestAnimationFrame(() => { if (element.open) focus(); });
    return () => {
      cancelAnimationFrame(frame);
      if (element.close) element.close();
      if (previous?.isConnected) previous.focus();
    };
  }, []);
  return <dialog ref={dialog} className={`diagnostic-dialog ${className}`} role="dialog" aria-labelledby={labelledBy}
    aria-modal="true" onCancel={event => { event.preventDefault(); dismiss.current(); }}
    onKeyDown={event => {
      if (event.key === "Escape") { event.preventDefault(); dismiss.current(); }
      if (event.key === "Tab") {
        const elements = Array.from(event.currentTarget.querySelectorAll<HTMLElement>(
          'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), summary, a[href], [tabindex="0"]',
        )).filter(element => element.getClientRects().length > 0);
        const first = elements[0], last = elements.at(-1);
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
      }
    }}>
    {children}
  </dialog>;
}

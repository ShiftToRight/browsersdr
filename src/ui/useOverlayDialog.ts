import { useLayoutEffect, useRef, type RefObject } from "react";

const exitMs = 200;

/** Native modal ownership lasts until the surface has returned to its launcher. */
export function useOverlayDialog(
  open: boolean,
  dialog: RefObject<HTMLDialogElement | null>,
  trigger: RefObject<HTMLElement | null>,
  focusSelector: string,
  onClosed?: () => void,
) {
  const openingAnchor = useRef<DOMRect | undefined>(undefined);
  const closedCallback = useRef(onClosed);
  closedCallback.current = onClosed;
  useLayoutEffect(() => {
    const panel = dialog.current;
    if (!panel) return;
    let closing: ReturnType<typeof setTimeout> | undefined;
    const reduced =
      window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? true;
    const anchorBounds = () => {
      const button = trigger.current;
      const bounds = button?.getBoundingClientRect();
      return bounds && bounds.width > 0 && bounds.height > 0
        ? bounds
        : openingAnchor.current;
    };
    const place = () => {
      const viewport = window.visualViewport;
      const x = viewport?.offsetLeft ?? 0,
        y = viewport?.offsetTop ?? 0;
      const width = viewport?.width ?? window.innerWidth;
      const height = viewport?.height ?? window.innerHeight;
      const padding = 8;
      panel.style.removeProperty("max-height");
      const maxHeight = parseFloat(getComputedStyle(panel).maxHeight);
      panel.style.maxHeight = `${Math.min(Number.isFinite(maxHeight) ? maxHeight : height, height - padding * 2)}px`;
      const anchor = anchorBounds();
      const w = panel.offsetWidth,
        h = panel.offsetHeight;
      const left = Math.max(
        x + padding,
        Math.min(anchor?.left ?? x + (width - w) / 2, x + width - w - padding),
      );
      const preferredTop = panel.classList.contains("utility-overlay")
        ? (document.querySelector(".app-topbar")?.getBoundingClientRect()
            .bottom ??
            anchor?.bottom ??
            y) + 12
        : (anchor?.top ?? y + (height - h) / 2);
      const top = Math.max(
        y + padding,
        Math.min(preferredTop, y + height - h - padding),
      );
      panel.style.inset = `${top}px auto auto ${left}px`;
      panel.style.margin = "0";
      panel.style.transform = "none";
      panel.style.transformOrigin = "0 0";
      panel.style.setProperty(
        "--overlay-button-transform",
        anchor && w && h
          ? `translate(${anchor.left - left}px, ${anchor.top - top}px) scale(${anchor.width / w}, ${anchor.height / h})`
          : "translate(0, 8px) scale(.98)",
      );
    };
    const finish = () => {
      if (panel.close) panel.close();
      else panel.removeAttribute("open");
      delete panel.dataset.closing;
      trigger.current?.focus({ preventScroll: true });
      closedCallback.current?.();
    };
    if (open) {
      const reopening = panel.open && panel.hasAttribute("data-closing");
      const current = reopening ? getComputedStyle(panel).transform : undefined;
      if (!panel.open) {
        openingAnchor.current = anchorBounds();
        if (panel.showModal) panel.showModal();
        else panel.setAttribute("open", "");
      }
      place();
      panel.style.setProperty(
        "--overlay-start-transform",
        current ?? "var(--overlay-button-transform)",
      );
      delete panel.dataset.closing;
      const observer =
        typeof ResizeObserver === "undefined"
          ? undefined
          : new ResizeObserver(place);
      observer?.observe(panel);
      window.addEventListener("resize", place);
      window.visualViewport?.addEventListener("resize", place);
      window.visualViewport?.addEventListener("scroll", place);
      return () => {
        observer?.disconnect();
        window.removeEventListener("resize", place);
        window.visualViewport?.removeEventListener("resize", place);
        window.visualViewport?.removeEventListener("scroll", place);
      };
    } else if (panel.open) {
      if (reduced) finish();
      else {
        // Continue from the current frame if dismissed before arrival completes.
        const current = getComputedStyle(panel).transform;
        place();
        panel.style.setProperty("--overlay-close-transform", current);
        panel.dataset.closing = "true";
        closing = setTimeout(finish, exitMs + 20);
      }
    }
    return () => clearTimeout(closing);
  }, [open, dialog, trigger]);
  useLayoutEffect(() => {
    if (open)
      dialog.current
        ?.querySelector<HTMLElement>(focusSelector)
        ?.focus({ preventScroll: true });
  }, [open, dialog, focusSelector]);
}

import { useLayoutEffect, useRef, type ReactNode } from "react";
import { AppIcon, type AppIconName } from "./AppIcon";
import "./UtilityOverlay.css";

export type UtilityView = "settings" | "help" | "antenna" | "compatibility" | "about";
const pages: Array<{ view: UtilityView; label: string; icon: AppIconName }> = [
  { view: "settings", label: "Settings", icon: "settings" },
  { view: "help", label: "Help & setup", icon: "help" },
  { view: "antenna", label: "Antenna guide", icon: "radio" },
  { view: "compatibility", label: "Compatibility & tests", icon: "activity" },
  { view: "about", label: "About BrowserSDR", icon: "info" },
];

/** Presentation state stays separate from the active receiver/workspace. */
export function UtilityOverlay({ view, workspaceLabel, returnFocusId, onViewChange, onDismiss, children }: {
  view: UtilityView | null;
  workspaceLabel: string;
  returnFocusId: string;
  onViewChange: (view: UtilityView) => void;
  onDismiss: () => void;
  children: ReactNode;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const closeButton = useRef<HTMLButtonElement>(null);
  const backdropPressed = useRef(false);
  const returnId = useRef(returnFocusId);
  returnId.current = returnFocusId;
  const open = view !== null;
  const selected = pages.find(page => page.view === view) ?? pages[1]!;
  useLayoutEffect(() => {
    if (!open) return;
    const element = dialog.current!;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const position = () => {
      const bottom = document.querySelector(".app-topbar")?.getBoundingClientRect().bottom ?? 80;
      const top = Math.min(Math.max(bottom + 12, 16), window.innerHeight * 0.25);
      element.style.setProperty("--utility-top", `${Math.round(top)}px`);
    };
    position();
    const header = document.querySelector(".app-topbar");
    const observer = typeof ResizeObserver === "undefined" ? undefined : new ResizeObserver(position);
    if (header) observer?.observe(header);
    window.addEventListener("resize", position);
    if (element.showModal) element.showModal();
    else element.setAttribute("open", "");
    closeButton.current?.focus({ preventScroll: true });
    const frame = requestAnimationFrame(() => closeButton.current?.focus({ preventScroll: true }));
    return () => {
      cancelAnimationFrame(frame);
      observer?.disconnect();
      window.removeEventListener("resize", position);
      if (element.close) element.close();
      else element.removeAttribute("open");
      document.body.style.overflow = previousOverflow;
      document.getElementById(returnId.current)?.focus({ preventScroll: true });
    };
  }, [open]);

  return <dialog ref={dialog} className={`utility-overlay${view === "antenna" ? " utility-overlay-antenna" : ""}`} hidden={!open} role="dialog" aria-modal="true" aria-labelledby="utility-overlay-heading"
    onCancel={event => { if (event.target === event.currentTarget) { event.preventDefault(); onDismiss(); } }}
    onPointerDown={event => {
      const bounds = event.currentTarget.getBoundingClientRect();
      backdropPressed.current = event.target === event.currentTarget && (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom);
    }}
    onClick={event => {
      if (!backdropPressed.current || event.target !== event.currentTarget) return;
      const bounds = event.currentTarget.getBoundingClientRect();
      if (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom) onDismiss();
    }}
    onKeyDown={event => {
      // Nested native report dialogs own their Escape and focus handling.
      if (!(event.target instanceof Element) || event.target.closest("dialog") !== event.currentTarget) return;
      if (event.key === "Escape") { event.preventDefault(); onDismiss(); }
      if (event.key === "Tab") {
        const elements = Array.from(event.currentTarget.querySelectorAll<HTMLElement>(
          'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), summary, a[href], [tabindex="0"]',
        )).filter(element => element.getClientRects().length > 0 && !element.closest("[hidden]"));
        const first = elements[0], last = elements.at(-1);
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
      }
    }}>
    <header className="utility-overlay-header">
      <span className="utility-overlay-emblem"><AppIcon name={selected.icon} /></span>
      <div><p className="eyebrow">{view === "settings" ? "Settings" : view === "antenna" ? "Antennas & reception" : "Help"}</p><h2 id="utility-overlay-heading">{selected.label}</h2></div>
      <button ref={closeButton} type="button" className="secondary utility-overlay-close" aria-label="Close utility overlay" onClick={onDismiss}><AppIcon name="close" /></button>
    </header>
    <nav className="utility-overlay-navigation" aria-label="Utility pages" hidden={view === "antenna"}>
      {pages.map(page => <button key={page.view} type="button" className="secondary" aria-pressed={view === page.view} aria-controls={`${page.view}-view`}
        onClick={() => {
          onViewChange(page.view);
          dialog.current?.querySelector(".utility-overlay-content")?.scrollTo?.({ top: 0 });
        }}><AppIcon name={page.icon} />{page.label}</button>)}
    </nav>
    <div className="utility-overlay-content">{children}</div>
    <footer className="utility-overlay-footer">{view === "antenna" ? <button type="button" className="secondary" onClick={() => onViewChange("help")}>Help &amp; setup</button> : <span>{workspaceLabel} stays underneath</span>}<button type="button" className="secondary" onClick={onDismiss}>Back to {workspaceLabel}</button></footer>
  </dialog>;
}

import { InstrumentButton } from "./InstrumentButton";
import { useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { useOverlayDialog } from "./useOverlayDialog";
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
export function UtilityOverlay({ view, workspaceLabel, returnFocusId, workspaceFocusId = returnFocusId, onViewChange, onDismiss, children }: {
  view: UtilityView | null;
  workspaceLabel: string;
  returnFocusId: string;
  workspaceFocusId?: string;
  onViewChange: (view: UtilityView) => void;
  onDismiss: () => void;
  children: ReactNode;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const closeButton = useRef<HTMLButtonElement>(null);
  const backdropPressed = useRef(false);
  const trigger = useRef<HTMLElement | null>(null);
  const returnToWorkspace = useRef(false);
  const open = view !== null;
  const lastView = useRef(view);
  const lastChildren = useRef(children);
  const [closed, setClosed] = useState(!open);
  if (open) { lastView.current = view; lastChildren.current = children; }
  const displayedView = view ?? lastView.current;
  const selected = pages.find(page => page.view === displayedView) ?? pages[1]!;
  useLayoutEffect(() => {
    trigger.current = document.getElementById(returnFocusId);
    if (!open) return;
    setClosed(false);
    returnToWorkspace.current = false;
    const position = () => {
      const bottom = document.querySelector(".app-topbar")?.getBoundingClientRect().bottom ?? 80;
      const top = Math.min(Math.max(bottom + 12, 16), window.innerHeight * 0.25);
      dialog.current?.style.setProperty("--utility-top", `${Math.round(top)}px`);
    };
    position();
    const header = document.querySelector(".app-topbar");
    const observer = typeof ResizeObserver === "undefined" ? undefined : new ResizeObserver(position);
    if (header) observer?.observe(header);
    window.addEventListener("resize", position);
    return () => { observer?.disconnect(); window.removeEventListener("resize", position); };
  }, [open, returnFocusId]);
  useOverlayDialog(open, dialog, trigger, ".utility-overlay-close", () => {
    setClosed(true);
    if (returnToWorkspace.current) document.getElementById(workspaceFocusId)?.focus({ preventScroll: true });
  });

  return <dialog ref={dialog} className={`utility-overlay overlay-motion${displayedView === "antenna" ? " utility-overlay-antenna" : ""}`} role="dialog" aria-modal="true" aria-labelledby="utility-overlay-heading"
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
      <div><p className="eyebrow">{displayedView === "settings" ? "Settings" : displayedView === "antenna" ? "Antennas & reception" : "Help"}</p><h2 id="utility-overlay-heading">{selected.label}</h2></div>
      <InstrumentButton ref={closeButton} type="button" className="secondary utility-overlay-close" aria-label="Close utility overlay" onClick={onDismiss}><AppIcon name="close" /></InstrumentButton>
    </header>
    <nav className="utility-overlay-navigation" aria-label="Utility pages" hidden={displayedView === "antenna"}>
      {pages.map(page => <InstrumentButton key={page.view} type="button" className="secondary" aria-pressed={displayedView === page.view} aria-controls={`${page.view}-view`}
        onClick={() => {
          onViewChange(page.view);
          dialog.current?.querySelector(".utility-overlay-content")?.scrollTo?.({ top: 0 });
        }}><AppIcon name={page.icon} />{page.label}</InstrumentButton>)}
    </nav>
    <div className="utility-overlay-content">{open || closed ? children : lastChildren.current}</div>
    <footer className="utility-overlay-footer">{displayedView === "antenna" ? <InstrumentButton type="button" className="secondary" onClick={() => onViewChange("help")}>Help &amp; setup</InstrumentButton> : <span>{workspaceLabel} stays underneath</span>}<InstrumentButton type="button" className="secondary" onClick={() => { returnToWorkspace.current = true; onDismiss(); }}>Back to {workspaceLabel}</InstrumentButton></footer>
  </dialog>;
}

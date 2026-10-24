import { useId, useRef, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { AppIcon, type AppIconName } from "./AppIcon";
import { useOverlayDialog } from "./useOverlayDialog";
import "./WorkspaceToolDialog.css";

/** Presentation only: the caller retains drafts and owns any ongoing operation. */
export function WorkspaceToolDialog({
  title,
  summary,
  icon = "sliders",
  open,
  onOpenChange,
  children,
  footer,
  placement = "source",
  className = "",
}: {
  title: string;
  summary?: string;
  icon?: AppIconName;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  children: ReactNode;
  footer?: ReactNode;
  placement?: "source" | "spectrum";
  className?: string;
}) {
  const id = useId();
  const dialog = useRef<HTMLDialogElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  useOverlayDialog(open, dialog, trigger, "[data-tool-close]");
  return (
    <>
      <button
        ref={trigger}
        type="button"
        className={`secondary workspace-tool-trigger ${className}`}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={id}
        onClick={() => onOpenChange(true)}
      >
        <AppIcon name={icon} />
        <span>
          <strong>{title}</strong>
          {summary && <small>{summary}</small>}
        </span>
        <span aria-hidden="true">›</span>
      </button>
      {createPortal(
        <dialog
          ref={dialog}
          id={id}
          className={`workspace-tool-dialog workspace-tool-${placement} overlay-motion`}
          aria-labelledby={`${id}-heading`}
          onCancel={(event) => {
            event.preventDefault();
            onOpenChange(false);
          }}
          onClick={(event) => {
            if (event.target !== event.currentTarget) return;
            const b = event.currentTarget.getBoundingClientRect();
            if (
              event.clientX < b.left ||
              event.clientX > b.right ||
              event.clientY < b.top ||
              event.clientY > b.bottom
            )
              onOpenChange(false);
          }}
          onKeyDown={(event) => {
            if (event.key !== "Tab") return;
            const controls = Array.from(
              event.currentTarget.querySelectorAll<HTMLElement>(
                'button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), summary, a[href], [tabindex="0"]',
              ),
            ).filter(
              (el) => el.getClientRects().length > 0 && !el.closest("[hidden]"),
            );
            const first = controls[0],
              last = controls.at(-1);
            if (event.shiftKey && document.activeElement === first) {
              event.preventDefault();
              last?.focus();
            } else if (!event.shiftKey && document.activeElement === last) {
              event.preventDefault();
              first?.focus();
            }
          }}
        >
          <header>
            <h3 id={`${id}-heading`}>{title}</h3>
            <button
              type="button"
              className="secondary"
              data-tool-close
              aria-label={`Close ${title}`}
              onClick={() => onOpenChange(false)}
            >
              <AppIcon name="close" />
            </button>
          </header>
          <div className="workspace-tool-body">{children}</div>
          <footer>
            {footer && <span>{footer}</span>}
            <button
              type="button"
              className="secondary"
              onClick={() => onOpenChange(false)}
            >
              Done
            </button>
          </footer>
        </dialog>,
        document.body,
      )}
    </>
  );
}

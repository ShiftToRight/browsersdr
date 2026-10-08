import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { AppIcon } from "../ui/AppIcon";

/** Optional plot information overlays the canvas without resizing or retuning it. */
export function SpectrumInfo({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const id = useId();
  const container = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    panel.current?.focus();
    const dismiss = (event: PointerEvent) => {
      if (
        event.target instanceof Node &&
        !container.current?.contains(event.target)
      )
        setOpen(false);
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setOpen(false);
        trigger.current?.focus();
      }
    };
    document.addEventListener("pointerdown", dismiss);
    document.addEventListener("keydown", escape);
    return () => {
      document.removeEventListener("pointerdown", dismiss);
      document.removeEventListener("keydown", escape);
    };
  }, [open]);
  return (
    <div
      ref={container}
      className="spectrum-info"
      onBlur={(event) => {
        if (
          event.relatedTarget instanceof Node &&
          !event.currentTarget.contains(event.relatedTarget)
        )
          setOpen(false);
      }}
    >
      <button
        ref={trigger}
        type="button"
        className="spectrum-info-button"
        aria-label="FFT & display details"
        title="FFT & display details"
        aria-expanded={open}
        aria-controls={id}
        aria-haspopup="dialog"
        onClick={() => setOpen((value) => !value)}
      >
        <AppIcon name="info" />
      </button>
      {open && (
        <div
          ref={panel}
          id={id}
          className="spectrum-info-panel"
          role="dialog"
          aria-labelledby={`${id}-heading`}
          tabIndex={-1}
        >
          <div className="spectrum-info-heading">
            <h3 id={`${id}-heading`}>FFT &amp; display details</h3>
            <button
              type="button"
              className="secondary"
              onClick={() => {
                setOpen(false);
                trigger.current?.focus();
              }}
            >
              Close
            </button>
          </div>
          {children}
        </div>
      )}
    </div>
  );
}

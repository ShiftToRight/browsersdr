import {
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type ButtonHTMLAttributes,
} from "react";
import { createPortal } from "react-dom";

/** A disabled action's prerequisite remains available to pointer and keyboard users. */
export function ActionButton({
  disabledReason,
  disabledLabel,
  children,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  disabledReason?: string;
  disabledLabel?: string;
}) {
  const hintId = useId();
  const anchor = useRef<HTMLSpanElement>(null);
  const tooltip = useRef<HTMLSpanElement>(null);
  const [active, setActive] = useState(false);
  const [position, setPosition] = useState({ left: 0, top: 0 });
  const showHint = Boolean(props.disabled && disabledReason);
  useLayoutEffect(() => {
    if (!active || !showHint) return;
    const place = () => {
      if (!anchor.current || !tooltip.current) return;
      const target = anchor.current.getBoundingClientRect();
      const hint = tooltip.current.getBoundingClientRect();
      const below = target.bottom + 6;
      const top =
        below + hint.height <= innerHeight - 8
          ? below
          : target.top - hint.height - 6;
      setPosition({
        left: Math.max(8, Math.min(target.left, innerWidth - hint.width - 8)),
        top: Math.max(8, Math.min(top, innerHeight - hint.height - 8)),
      });
    };
    place();
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    return () => {
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
    };
  }, [active, showHint, disabledReason]);
  return (
    <span
      ref={anchor}
      className="action-hint"
      tabIndex={showHint ? 0 : undefined}
      role={showHint ? "group" : undefined}
      aria-label={
        showHint
          ? (disabledLabel ??
            props["aria-label"] ??
            (typeof children === "string" ? children : "Unavailable action"))
          : undefined
      }
      aria-describedby={showHint ? hintId : undefined}
      onFocus={() => setActive(true)}
      onBlur={() => setActive(false)}
      onMouseEnter={() => setActive(true)}
      onMouseLeave={() => setActive(false)}
      onKeyDown={(event) => {
        if (event.key === "Escape") setActive(false);
      }}
    >
      <button
        {...props}
        aria-describedby={showHint ? hintId : props["aria-describedby"]}
      >
        {children}
      </button>
      {showHint &&
        createPortal(
          <span
            ref={tooltip}
            id={hintId}
            className="action-hint-text"
            role="tooltip"
            style={{ ...position, display: active ? "block" : "none" }}
          >
            {disabledReason}
          </span>,
          document.body,
        )}
    </span>
  );
}

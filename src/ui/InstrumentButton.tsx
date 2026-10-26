import { useState, type ComponentPropsWithRef, type ReactNode } from "react";
import { useTheme } from "./themes";

/** The native button/hit box stays still; only its cap and lighting move. */
export function InstrumentButton({
  children,
  className = "",
  onKeyDown,
  onKeyUp,
  onBlur,
  ...props
}: ComponentPropsWithRef<"button">) {
  const theme = useTheme();
  const [keyPressed, setKeyPressed] = useState(false);
  const flat =
    /(?:^|\s)(?:decoder-record|monitor-frequency|band-guide-segment|mode-chooser-card-select)(?:\s|$)/.test(
      className,
    );
  if (theme !== "graphite-studio" || flat)
    return (
      <button
        {...props}
        className={className}
        onKeyDown={onKeyDown}
        onKeyUp={onKeyUp}
        onBlur={onBlur}
      >
        {children}
      </button>
    );
  return (
    <button
      {...props}
      className={`${className} instrument-key`}
      data-key-pressed={(!props.disabled && keyPressed) || undefined}
      onKeyDown={(event) => {
        onKeyDown?.(event);
        if (
          !event.defaultPrevented &&
          (event.key === " " || event.key === "Enter")
        )
          setKeyPressed(true);
      }}
      onKeyUp={(event) => {
        onKeyUp?.(event);
        setKeyPressed(false);
      }}
      onBlur={(event) => {
        setKeyPressed(false);
        onBlur?.(event);
      }}
    >
      <span className="instrument-key-face">{children}</span>
    </button>
  );
}

/** A native details summary keeps its semantics and trigger geometry. */
export function InstrumentFace({ children }: { children: ReactNode }) {
  return useTheme() === "graphite-studio" ? (
    <span className="instrument-key-face">{children}</span>
  ) : (
    <>{children}</>
  );
}

import {
  useEffect,
  useState,
  type ComponentPropsWithRef,
  type CSSProperties,
} from "react";
import { useTheme } from "./themes";

/** Decoration follows the controlled value; native input owns every gesture. */
export function InstrumentRange({
  onPointerDown,
  onPointerUp,
  onPointerCancel,
  onBlur,
  ...props
}: Omit<ComponentPropsWithRef<"input">, "type">) {
  const theme = useTheme();
  const [gripped, setGripped] = useState(false);
  useEffect(() => {
    if (!gripped) return;
    const release = () => setGripped(false);
    window.addEventListener("pointerup", release);
    window.addEventListener("pointercancel", release);
    window.addEventListener("blur", release);
    return () => {
      window.removeEventListener("pointerup", release);
      window.removeEventListener("pointercancel", release);
      window.removeEventListener("blur", release);
    };
  }, [gripped]);
  if (theme !== "graphite-studio")
    return (
      <input
        {...props}
        type="range"
        onPointerDown={onPointerDown}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerCancel}
        onBlur={onBlur}
      />
    );
  const min = Number(props.min ?? 0),
    max = Number(props.max ?? 100);
  const raw = Number(props.value ?? props.defaultValue ?? (min + max) / 2);
  const fraction =
    Number.isFinite(raw) && max > min
      ? Math.max(0, Math.min(1, (raw - min) / (max - min)))
      : 0;
  return (
    <span
      className="instrument-range"
      data-gripped={gripped || undefined}
      data-disabled={props.disabled || undefined}
      style={{ "--fader-position": fraction } as CSSProperties}
    >
      <span className="instrument-range-scale" aria-hidden="true" />
      <span className="instrument-range-rail" aria-hidden="true">
        <span className="instrument-range-fill" />
      </span>
      <span className="instrument-range-cap" aria-hidden="true">
        <span />
      </span>
      <input
        {...props}
        type="range"
        onPointerDown={(event) => {
          onPointerDown?.(event);
          if (!event.defaultPrevented && !props.disabled) setGripped(true);
        }}
        onPointerUp={(event) => {
          setGripped(false);
          onPointerUp?.(event);
        }}
        onPointerCancel={(event) => {
          setGripped(false);
          onPointerCancel?.(event);
        }}
        onBlur={(event) => {
          setGripped(false);
          onBlur?.(event);
        }}
      />
    </span>
  );
}

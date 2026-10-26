import { useLayoutEffect, useRef, type ComponentPropsWithoutRef } from "react";
import { useTheme } from "./themes";

/** One sliding cap follows the selected native tab, including wrapped rows. */
export function InstrumentTabs({
  selected,
  children,
  className = "",
  ...props
}: ComponentPropsWithoutRef<"div"> & { selected: string }) {
  const theme = useTheme();
  const rail = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const element = rail.current;
    if (theme !== "graphite-studio" || !element) return;
    const measure = () => {
      const tab = element.querySelector<HTMLElement>('[role="tab"][aria-selected="true"]');
      if (!tab || !tab.offsetWidth || !element.offsetWidth) return;
      element.style.setProperty("--tab-x", `${tab.offsetLeft}px`);
      element.style.setProperty("--tab-y", `${tab.offsetTop}px`);
      element.style.setProperty("--tab-width", `${tab.offsetWidth}px`);
      element.style.setProperty("--tab-height", `${tab.offsetHeight}px`);
      element.dataset.tabsReady = "true";
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    for (const tab of element.querySelectorAll('[role="tab"]')) observer.observe(tab);
    return () => observer.disconnect();
  }, [theme, selected]);
  return (
    <div
      {...props}
      role="tablist"
      ref={rail}
      className={`${className}${theme === "graphite-studio" ? " instrument-tabs" : ""}`.trim()}
    >
      {theme === "graphite-studio" && <span className="instrument-tabs-indicator" aria-hidden="true" />}
      {children}
    </div>
  );
}

import { Suspense, useEffect, useState, type ReactNode } from "react";

/** Load on first visit, then keep component-owned scan/review state alive. */
export function DeferredWorkspace({
  active,
  children,
}: {
  active: boolean;
  children: ReactNode;
}) {
  const [visited, setVisited] = useState(active);
  useEffect(() => {
    if (active) setVisited(true);
  }, [active]);
  return active || visited ? (
    <Suspense fallback={<p role="status">Opening workspace…</p>}>
      {children}
    </Suspense>
  ) : null;
}

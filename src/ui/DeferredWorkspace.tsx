import { memo, Suspense, useEffect, useState, type ReactNode } from "react";

type Contents = ReactNode | (() => ReactNode);
const RetainedContents = memo(
  function RetainedContents({
    children,
  }: {
    active: boolean;
    freeze: boolean;
    children: Contents;
  }) {
    return typeof children === "function" ? children() : children;
  },
  (_previous, next) => next.freeze && !next.active,
);

/** The first visit is sticky so hidden workspaces retain their owned state. */
export function useWorkspaceVisited(active: boolean): boolean {
  const [visited, setVisited] = useState(active);
  useEffect(() => {
    if (active) setVisited(true);
  }, [active]);
  return active || visited;
}

/** Defer factory children as well as mounting, then keep owned state alive. */
export function DeferredWorkspace({
  active,
  freezeWhenInactive = false,
  children,
}: {
  active: boolean;
  freezeWhenInactive?: boolean;
  children: Contents;
}) {
  const visited = useWorkspaceVisited(active);
  return visited ? (
    <Suspense fallback={<p role="status">Opening workspace…</p>}>
      <RetainedContents active={active} freeze={freezeWhenInactive}>
        {children}
      </RetainedContents>
    </Suspense>
  ) : null;
}

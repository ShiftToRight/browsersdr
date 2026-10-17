import { lazy, Suspense, useState } from "react";
import { AppIcon } from "./AppIcon";
import type { SearchOverlayProps } from "./SearchOverlayFeature";
export type { SearchOverlayProps } from "./SearchOverlayFeature";
const Feature = lazy(() => import("./SearchOverlayFeature").then(module => ({default: module.SearchOverlayFeature})));

/** Keep catalog clients and result UI dormant until Search is deliberately opened. Retain drafts thereafter. */
export function SearchOverlay(props: SearchOverlayProps) {
  const [loaded, setLoaded] = useState(false);
  const trigger = <button type="button" className="secondary discovery-trigger" aria-haspopup="dialog" aria-expanded={loaded} disabled={loaded} onClick={() => setLoaded(true)}><AppIcon name="search" />{loaded ? " Opening search…" : " Search"}</button>;
  return loaded ? <Suspense fallback={trigger}><Feature {...props} /></Suspense> : trigger;
}

import { lazy, useState, type ComponentProps } from "react";
import type { FavoritesPanel as Panel } from "./FavoritesPanel";
import { DeferredWorkspace } from "./DeferredWorkspace";
import { AppIcon } from "./AppIcon";
const FavoritesPanel = lazy(() =>
  import("./FavoritesPanel").then((module) => ({
    default: module.FavoritesPanel,
  })),
);
export function FavoritesLauncher(props: ComponentProps<typeof Panel>) {
  const [visited, setVisited] = useState(false);
  if (!visited && !props.draft)
    return (
      <>
        <button
          className="favorite-launcher secondary"
          type="button"
          aria-haspopup="dialog"
          aria-expanded={false}
          onClick={() => setVisited(true)}
        >
          <AppIcon name="star" /> Favorites <span>{props.items.length}</span>
          {props.storageMessage && <AppIcon name="alert" />}
        </button>
        {props.storageMessage && (
          <p className="favorite-storage-warning" role="alert">
            {props.storageMessage}
          </p>
        )}
      </>
    );
  return (
    <DeferredWorkspace active>
      <FavoritesPanel {...props} initialOpen />
    </DeferredWorkspace>
  );
}

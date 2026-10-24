import { useEffect, useRef, useState } from "react";
import {
  BOOKMARK_KEY,
  exportBookmarks,
  importBookmarks,
  type Bookmark,
} from "../radio/bookmarks";
function readFavorites(): {
  items: Bookmark[];
  message: string;
  corrupt: boolean;
} {
  let saved: string | null;
  try {
    saved = localStorage.getItem(BOOKMARK_KEY);
  } catch {
    return {
      items: [],
      message:
        "Browser storage is unavailable. Favorites can be used in this tab; export a backup before closing it.",
      corrupt: false,
    };
  }
  try {
    return {
      items: saved ? importBookmarks(saved) : [],
      message: "",
      corrupt: false,
    };
  } catch {
    return {
      items: [],
      message:
        "Saved favorites could not be read. Import a valid backup to restore them. Existing browser data has been preserved.",
      corrupt: true,
    };
  }
}
export function useFavorites() {
  const [state, setState] = useState(readFavorites);
  const latest = useRef(state);
  latest.current = state;
  const change = (
    update: (items: Bookmark[]) => Bookmark[],
    restore = false,
  ) => {
    const old = latest.current;
    if (old.corrupt && !restore) throw new Error(old.message);
    const items = importBookmarks(exportBookmarks(update(old.items)));
    let message = "";
    try {
      localStorage.setItem(BOOKMARK_KEY, exportBookmarks(items));
    } catch {
      message =
        "Favorites are available in this tab, but browser storage failed. Export a backup before closing it.";
    }
    const next = { items, message, corrupt: false };
    latest.current = next;
    setState(next);
  };
  useEffect(() => {
    const sync = (event: StorageEvent) => {
      if (event.key === BOOKMARK_KEY || event.key === null) {
        const next = readFavorites();
        latest.current = next;
        setState(next);
      }
    };
    window.addEventListener("storage", sync);
    return () => window.removeEventListener("storage", sync);
  }, []);
  return { ...state, change };
}

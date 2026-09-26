import { useEffect, useState } from "react";

/** Presentation visibility; acquisition and health monitoring remain independent. */
export function usePageVisible(active: boolean): boolean {
  const [pageVisible, setPageVisible] = useState(
    () => document.visibilityState !== "hidden",
  );
  useEffect(() => {
    const refresh = () => setPageVisible(document.visibilityState !== "hidden");
    document.addEventListener("visibilitychange", refresh);
    return () => document.removeEventListener("visibilitychange", refresh);
  }, []);
  return active && pageVisible;
}

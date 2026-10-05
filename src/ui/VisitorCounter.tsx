import { useEffect, useState } from "react";

interface VisitorCount {
  visitors: number;
}

function parseCount(value: unknown): VisitorCount | null {
  if (!value || typeof value !== "object") return null;
  const data = value as Record<string, unknown>;
  if (
    data.schemaVersion !== 1 ||
    data.available !== true ||
    typeof data.visitors !== "number" ||
    !Number.isSafeInteger(data.visitors) ||
    data.visitors < 0
  )
    return null;
  return { visitors: data.visitors };
}

export function VisitorCounter() {
  const [count, setCount] = useState<VisitorCount | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    void (async () => {
      try {
        const response = await fetch(
          new URL("./visitor-count.json", document.baseURI),
          {
            cache: "no-store",
            credentials: "omit",
            signal: controller.signal,
          },
        );
        if (!response.ok) return;
        const data = parseCount(await response.json());
        if (!controller.signal.aborted) setCount(data);
      } catch {
        // Static/offline installations can omit the optional aggregate.
      }
    })();
    return () => controller.abort();
  }, []);

  if (!count) return null;
  return (
    <footer className="about-panel about-visitors" aria-label="Visitor count">
      <p>
        <strong>{count.visitors.toLocaleString("en-GB")}</strong> visitors since
        launch
      </p>
    </footer>
  );
}

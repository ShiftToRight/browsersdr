import { useEffect, useState } from "react";
import type { AnalysisPipeline } from "../dsp/analysisPipeline";
import type { SourceSessionMetadata } from "../radio/types";

export function InputClippingWarning({
  pipeline,
  session,
  running,
}: {
  pipeline: Pick<AnalysisPipeline, "getInputClipping">;
  session?: SourceSessionMetadata;
  running: boolean;
}) {
  const [sample, setSample] = useState<{
    generation: number;
    source: string;
    fraction: number;
  }>();
  useEffect(() => {
    if (!running || !session || !["rtl-sdr", "hackrf"].includes(session.source))
      return;
    const refresh = () => {
      const next =
        document.visibilityState === "hidden"
          ? undefined
          : pipeline.getInputClipping();
      setSample(
        next
          ? {
              generation: session.sessionGeneration,
              source: session.source,
              fraction: next.clippedFraction,
            }
          : undefined,
      );
    };
    const timer = setInterval(refresh, 500);
    document.addEventListener("visibilitychange", refresh);
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", refresh);
    };
  }, [pipeline, running, session?.sessionGeneration, session?.source, session]);
  if (
    !running ||
    !sample ||
    sample.generation !== session?.sessionGeneration ||
    sample.source !== session.source
  )
    return null;
  return (
    <p className="input-clipping-warning" role="status">
      <strong>Input clipping detected</strong> ·{" "}
      {(sample.fraction * 100).toFixed(1)}% of sampled I/Q components reached
      ADC limits.{" "}
      {session.source === "hackrf"
        ? "Lower LNA/VGA gain or turn off the RF amplifier."
        : "Reduce RF gain; use manual gain if needed."}{" "}
      This check cannot detect every kind of RF overload.
    </p>
  );
}

import { useEffect, useRef } from "react";
import type { OpenWebRxClient } from "./openWebRxClient";
import type { RemoteConfig } from "./openWebRxProtocol";

export function RemoteSpectrum({
  client,
  config,
  paused,
}: {
  client: Pick<OpenWebRxClient, "subscribeFrames">;
  config?: RemoteConfig;
  paused: boolean;
}) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const pauseRef = useRef(paused);
  useEffect(() => {
    pauseRef.current = paused;
  }, [paused]);
  const center = config?.center,
    rate = config?.rate,
    fftSize = config?.fftSize;
  const levels = useRef({ floor: config?.floor, ceiling: config?.ceiling });
  useEffect(() => {
    levels.current = { floor: config?.floor, ceiling: config?.ceiling };
  }, [config?.floor, config?.ceiling]);
  useEffect(() => {
    const element = canvas.current,
      context = element?.getContext("2d");
    if (!element || !context) return;
    const width = 1024,
      height = 320,
      plot = 112;
    element.width = width;
    element.height = height;
    let latest: Float32Array | undefined,
      dirty = true,
      animation = 0,
      lastDraw = 0;
    const clear = () => {
      context.fillStyle = "#071321";
      context.fillRect(0, 0, width, height);
      latest = undefined;
      dirty = true;
    };
    clear();
    const unsubscribe = client.subscribeFrames((frame) => {
      if (!frame) clear();
      else if (!pauseRef.current) {
        latest = frame;
        dirty = true;
      }
    });
    const draw = (time: number) => {
      animation = requestAnimationFrame(draw);
      if (!dirty || time - lastDraw < 33) return;
      dirty = false;
      lastDraw = time;
      const { floor, ceiling } = levels.current;
      if (
        !latest ||
        center === undefined ||
        rate === undefined ||
        floor === undefined ||
        ceiling === undefined
      ) {
        context.fillStyle = "#9eb1c8";
        context.font = "18px sans-serif";
        context.fillText("Waiting for server spectrum", 24, 60);
        return;
      }
      context.drawImage(
        element,
        0,
        plot,
        width,
        height - plot - 1,
        0,
        plot + 1,
        width,
        height - plot - 1,
      );
      context.fillStyle = "#071321";
      context.fillRect(0, 0, width, plot);
      const range = Math.max(1, ceiling - floor);
      context.strokeStyle = "#57c7db";
      context.lineWidth = 1.5;
      context.beginPath();
      for (let x = 0; x < width; x++) {
        const first = Math.floor((x * latest.length) / width),
          end = Math.max(
            first + 1,
            Math.floor(((x + 1) * latest.length) / width),
          );
        let level = -300;
        for (let i = first; i < end; i++) level = Math.max(level, latest[i]!);
        const scaled = Math.max(0, Math.min(1, (level - floor) / range));
        const y = 8 + (1 - scaled) * (plot - 30);
        if (x) context.lineTo(x, y);
        else context.moveTo(x, y);
        context.fillStyle = `hsl(${230 - scaled * 210} 80% ${8 + scaled * 55}%)`;
        context.fillRect(x, plot, 1, 1);
      }
      context.stroke();
      context.font = "14px sans-serif";
      context.fillStyle = "#bdcede";
      const mhz = (value: number) => `${(value / 1e6).toFixed(3)} MHz`;
      context.textAlign = "left";
      context.fillText(mhz(center - rate / 2), 8, plot - 5);
      context.textAlign = "center";
      context.fillText(mhz(center), width / 2, plot - 5);
      context.textAlign = "right";
      context.fillText(mhz(center + rate / 2), width - 8, plot - 5);
      context.textAlign = "left";
    };
    animation = requestAnimationFrame(draw);
    return () => {
      unsubscribe();
      cancelAnimationFrame(animation);
    };
  }, [client, center, rate, fftSize]); // Config fields own the display generation.
  return (
    <canvas
      ref={canvas}
      className="remote-spectrum"
      role="img"
      aria-label="Remote server spectrum and waterfall, relative power"
    />
  );
}

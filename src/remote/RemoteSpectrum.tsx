import { useEffect, useRef } from "react";
import { useTheme } from "../ui/themes";
import { SPECTRUM_PALETTES, rgbCss } from "../graphics/spectrumPalette";
import { waterfallColor } from "../graphics/canvasSpectrum";
import type { OpenWebRxClient } from "./openWebRxClient";
import type { RemoteConfig } from "./openWebRxProtocol";

export function RemoteSpectrum({
  client,
  config,
  paused,
  active = true,
}: {
  client: Pick<OpenWebRxClient, "subscribeFrames">;
  config?: RemoteConfig;
  paused: boolean;
  active?: boolean;
}) {
  const theme = useTheme();
  const themeRef = useRef(theme);
  themeRef.current = theme;
  const redrawRef = useRef<() => void>(() => undefined);
  useEffect(() => { redrawRef.current(); }, [theme]);
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
    if (!active) return;
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
    const rowCount = height - plot;
    const history = new Float32Array(width * rowCount);
    let nextRow = 0, retained = 0, newRow = false, repaintHistory = false;
    redrawRef.current = () => { dirty = true; repaintHistory = true; };
    const background = () => themeRef.current === "classic" ? "#071321" : rgbCss(SPECTRUM_PALETTES[themeRef.current].background);
    const color = (scaled: number) => themeRef.current === "classic"
      ? `hsl(${230 - scaled * 210} 80% ${8 + scaled * 55}%)`
      : `rgb(${waterfallColor(scaled, 0, 1, SPECTRUM_PALETTES[themeRef.current]).join(" ")})`;
    const paintHistory = () => {
      context.fillStyle = background();
      context.fillRect(0, plot, width, rowCount);
      if (!retained) return;
      const image = context.createImageData(width, retained);
      for (let age = 0; age < retained; age++) {
        const row = (nextRow + rowCount - 1 - age) % rowCount;
        for (let x = 0; x < width; x++) {
          const scaled = history[row * width + x]!;
          const offset = (age * width + x) * 4;
          if (themeRef.current === "classic") {
            // Standard HSL conversion, matching the original remote palette.
            const hue = (230 - scaled * 210) / 30;
            const lightness = (8 + scaled * 55) / 100;
            const a = .8 * Math.min(lightness, 1 - lightness);
            for (let channel = 0; channel < 3; channel++) {
              const k = ([0, 8, 4][channel]! + hue) % 12;
              image.data[offset + channel] = 255 * (lightness - a * Math.max(-1, Math.min(k - 3, 9 - k, 1)));
            }
          } else {
            image.data.set(waterfallColor(scaled, 0, 1, SPECTRUM_PALETTES[themeRef.current]), offset);
          }
          image.data[offset + 3] = 255;
        }
      }
      context.putImageData(image, 0, plot);
    };
    const clear = () => {
      context.fillStyle = background();
      context.fillRect(0, 0, width, height);
      latest = undefined;
      nextRow = 0; retained = 0; newRow = false; repaintHistory = false;
      dirty = true;
    };
    clear();
    const unsubscribe = client.subscribeFrames((frame) => {
      if (!frame) clear();
      else if (!pauseRef.current) {
        latest = frame;
        newRow = true;
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
      if (repaintHistory) { paintHistory(); repaintHistory = false; }
      if (newRow) context.drawImage(
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
      context.fillStyle = background();
      context.fillRect(0, 0, width, plot);
      const range = Math.max(1, ceiling - floor);
      context.strokeStyle = themeRef.current === "classic" ? "#57c7db" : rgbCss(SPECTRUM_PALETTES[themeRef.current].trace);
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
        if (newRow) {
          history[nextRow * width + x] = scaled;
          context.fillStyle = color(scaled);
          context.fillRect(x, plot, 1, 1);
        }
      }
      if (newRow) { nextRow = (nextRow + 1) % rowCount; retained = Math.min(rowCount, retained + 1); newRow = false; }
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
      redrawRef.current = () => undefined;
      unsubscribe();
      cancelAnimationFrame(animation);
    };
  }, [client, center, rate, fftSize, active]); // Config fields own the display generation.
  return (
    <canvas
      ref={canvas}
      className="remote-spectrum"
      role="img"
      aria-label="Remote server spectrum and waterfall, relative power"
    />
  );
}

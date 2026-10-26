import { channelOnlyDisplayChange, SurfaceMarkerMotion } from "./spectrumDisplaySession";
import { InstrumentButton } from "../ui/InstrumentButton";
import type { GpuSpectrumSurface } from "./gpuSpectrumSurface";
import { surfaceSettings, SURFACE_SETTINGS_KEY, SURFACE_MAX_DIMENSION, SURFACE_TRACE_FRACTION, type SpectrumSurfaceSettings } from "./spectrumSurfaceSettings";
import "./SpectrumSurface.css";
import { snapChannelFrequency } from "./channelRaster";
import type { HoverSpectrumFrame } from "./spectrumHoverMath";
import { ActionButton } from "../ui/ActionButton";
import { WorkspaceToolDialog } from "../ui/WorkspaceToolDialog";
import type { CanvasSpectrum } from "./canvasSpectrum";
import { SPECTRUM_PALETTES } from "./spectrumPalette";
import { useTheme } from "../ui/themes";
import { SpectrumInfo } from "./SpectrumInfo";
import { spectrumDisplayScale } from "./spectrumDisplayScale";
import { usePageVisible } from "../ui/usePageVisible";
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type MouseEvent, type ReactNode } from "react";
import type { AnalysisPipeline } from "../dsp/analysisPipeline";
import { frequencyForPixel } from "../dsp/frequencyScale";
import { FFT_SIZE } from "../dsp/spectrumMath";
import type { SourceSessionMetadata, SpectrumFrame } from "../radio/types";
import { GpuSpectrum, gpuFftSize } from "../dsp/gpuSpectrum";
import { GpuAnalysisTap } from "../dsp/gpuAnalysisTap";
import { WaterfallHistory } from "./waterfallHistory";
import { HISTORY_ROWS, spectrumShader } from "./spectrumShader";
import { defaultDiagnosticRecorder } from "../diagnostics/diagnosticRecorder";
import { channelPassbands, formatPassbandWidth } from "./channelPassband";
import { formatFrequencyMHz } from "../ui/frequencyFormat";
import { spectrumFrequencyTicks } from "./spectrumFrequencyTicks";
import { lazy, Suspense, type CSSProperties } from "react";
const SpectrumHover = lazy(() => import("./SpectrumHover").then(module => ({ default: module.SpectrumHover })));
const BandGuideFeature = lazy(() => import("./BandGuideFeature").then(module => ({default:module.BandGuideFeature})));

export interface SpectrumDisplayStatus {
  kind: "checking" | "ready" | "unsupported" | "error";
  hasFrame: boolean;
  paused: boolean;
  stalled?: boolean;
  renderer?: "webgpu" | "canvas2d";
}

type GpuState = {
  kind: "checking" | "ready" | "unsupported" | "error";
  message: string;
};

const GPU_VERTEX_STAGE = 0x1;
const GPU_FRAGMENT_STAGE = 0x2;
const GPU_BUFFER_COPY_DST = 0x8;
const GPU_BUFFER_UNIFORM = 0x40;
const GPU_BUFFER_STORAGE = 0x80;
const GAP_LEVEL_DB = -10_000;

function formatFrequency(frequencyHz: number): string {
  return `${formatFrequencyMHz(frequencyHz)} MHz`;
}

function frequencyPercent(
  frequencyHz: number,
  centerFrequencyHz: number,
  sampleRateHz: number,
): number {
  return (0.5 + (frequencyHz - centerFrequencyHz) / sampleRateHz) * 100;
}

export function WebGpuSpectrum({
  pipeline,
  session,
  onTune,
  onStatusChange,
  onOpenAcquire,
  onOpenDiagnostics,
  active = true,
  receiving = Boolean(session),
  replayPaused = false,
  replayEnded = false,
  tuningControls,
  displaySettings,
  onDisplaySettingsChange,
}: {
  displaySettings?: { floorDb: number; rangeDb: number };
  onDisplaySettingsChange?: (settings: { floorDb: number; rangeDb: number }) => void;
  active?: boolean;
  receiving?: boolean;
  replayPaused?: boolean;
  replayEnded?: boolean;
  tuningControls?: ReactNode;
  onStatusChange?: (status: SpectrumDisplayStatus) => void;
  onOpenAcquire?: () => void;
  onOpenDiagnostics?: () => void;
  pipeline: AnalysisPipeline;
  session?: SourceSessionMetadata;
  onTune?: (frequencyHz: number) => void;
}) {
  const [displayOpen, setDisplayOpen] = useState(false);
  const [surfacePreferences, setSurfacePreferences] = useState(() => {
    try { return surfaceSettings(JSON.parse(localStorage.getItem(SURFACE_SETTINGS_KEY) ?? "null")); }
    catch { return surfaceSettings(); }
  });
  const surfacePreferencesRef = useRef(surfacePreferences);
  surfacePreferencesRef.current = surfacePreferences;
  const [surfaceState, setSurfaceState] = useState("idle");
  const [surfaceDuration, setSurfaceDuration] = useState(0);
  const changeSurface = (patch: Partial<SpectrumSurfaceSettings>) => {
    const next = surfaceSettings({ ...surfacePreferencesRef.current, ...patch });
    surfacePreferencesRef.current = next;
    setSurfacePreferences(next);
    try { localStorage.setItem(SURFACE_SETTINGS_KEY, JSON.stringify(next)); } catch { /* Optional local presentation preference. */ }
  };
  useEffect(() => { if (!active) setDisplayOpen(false); }, [active]);
  const [rasterRegion, setRasterRegion] = useState("general");
  const [snapChannels, setSnapChannels] = useState(() => {
    try { return localStorage.getItem("browsersdr.channel-snap.v1") !== "off"; } catch { return true; }
  });
  const theme = useTheme();
  const paletteRef = useRef(SPECTRUM_PALETTES[theme]);
  paletteRef.current = SPECTRUM_PALETTES[theme];
  const visible = usePageVisible(active);
  const visibleRef = useRef(visible);
  visibleRef.current = visible;
  const requestedFftSize = gpuFftSize();
  const [fftSize, setFftSize] = useState<number>(requestedFftSize ?? FFT_SIZE);
  const [fftMessage, setFftMessage] = useState(
    requestedFftSize
      ? "Experimental GPU FFT initializing; WASM remains active."
      : "",
  );
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const hoverFrameRef = useRef<HoverSpectrumFrame | undefined>(undefined);
  const [hoverEnabled, setHoverEnabled] = useState(() => {
    try { return localStorage.getItem("browsersdr.spectrum-hover.v1") !== "off"; }
    catch { return true; }
  });
  const sessionRef = useRef(session);
  sessionRef.current = session;
  const renderRef = useRef<() => void>(() => undefined);
  const sessionChangeRef = useRef<(next?: SourceSessionMetadata) => void>(() => undefined);
  const surfacePickRef = useRef<(x:number,y:number,width:number,height:number) => number | undefined>(() => undefined);
  useLayoutEffect(() => { sessionChangeRef.current(session); }, [session]);
  const scaleCallback = useRef(onDisplaySettingsChange);
  scaleCallback.current = onDisplaySettingsChange;
  const [guideGap, setGuideGap] = useState(0);
  const [guideCoordinates, setGuideCoordinates] = useState<{center:number;rate:number;generation:number}>();
  const guideCoordinatesRef = useRef(guideCoordinates);
  const [displayWidth, setDisplayWidth] = useState(0);
  const rememberGuideCoordinates = (frame: SpectrumFrame) => {
    const context = `${frame.centerFrequencyHz}:${frame.sampleRateHz}`;
    if (automaticScaleRef.current && scaledContext.current !== context && fitScaleRef.current(frame.bins)) scaledContext.current = context;
    const old = guideCoordinatesRef.current;
    if (old?.center === frame.centerFrequencyHz && old.rate === frame.sampleRateHz && old.generation === frame.sessionGeneration) return;
    const next = {center:frame.centerFrequencyHz,rate:frame.sampleRateHz,generation:frame.sessionGeneration};
    guideCoordinatesRef.current = next;
    setGuideCoordinates(next);
  };
  useEffect(() => {
    if (visible) renderRef.current();
  }, [visible]);
  useEffect(() => { renderRef.current(); }, [theme]);
  const pausedRef = useRef(false);
  const floorRef = useRef(-105);
  const [automaticScale, setAutomaticScale] = useState(() => {
    try { return localStorage.getItem("browsersdr.spectrum-auto-scale") !== "off"; } catch { return true; }
  });
  const automaticScaleRef = useRef(automaticScale);
  automaticScaleRef.current = automaticScale;
  const scaledContext = useRef("");
  const fitScaleRef = useRef<(bins: Float32Array) => boolean>(() => false);
  const changeScaleMode = (enabled: boolean) => {
    automaticScaleRef.current = enabled;
    setAutomaticScale(enabled);
    scaledContext.current = "";
    try { localStorage.setItem("browsersdr.spectrum-auto-scale", enabled ? "on" : "off"); } catch { /* Optional display preference. */ }
  };
  const rangeRef = useRef(90);
  const [paused, setPaused] = useState(false);
  const [floorDb, setFloorDb] = useState(-105);
  const [rangeDb, setRangeDb] = useState(90);
  useEffect(() => {
    if (!displaySettings) return;
    floorRef.current = displaySettings.floorDb;
    rangeRef.current = displaySettings.rangeDb;
    setFloorDb(displaySettings.floorDb);
    setRangeDb(displaySettings.rangeDb);
    renderRef.current();
  }, [displaySettings]);
  const [renderer, setRenderer] = useState<"webgpu" | "canvas2d">("webgpu");
  const surfaceActive = surfacePreferences.view === "3d" && surfaceState === "ready" && renderer === "webgpu" && !requestedFftSize;
  const surfaceCombined = surfaceActive && surfacePreferences.layout === "combined";
  const surfaceActiveRef = useRef(surfaceActive);
  surfaceActiveRef.current = surfaceActive;
  useEffect(() => { renderRef.current(); }, [surfacePreferences, surfaceActive]);
  const [fallbackReason, setFallbackReason] = useState("");
  const [gpuAttempt, setGpuAttempt] = useState(0);
  const latestBinsRef = useRef<Float32Array | undefined>(undefined);
  const lastFrameAt = useRef(0);
  const [stalled, setStalled] = useState(false);
  const [displayedGeneration, setDisplayedGeneration] = useState<number>();
  const hasFrame = Boolean(
    session && displayedGeneration === session.sessionGeneration,
  );
  const [state, setState] = useState<GpuState>({
    kind: "checking",
    message: "Requesting a GPU adapter and device…",
  });
  const validGuideCoordinates = hasFrame && guideCoordinates?.generation === session?.sessionGeneration ? guideCoordinates : undefined;
  const guideGapRef = useRef(guideGap);
  guideGapRef.current = guideGap;
  useEffect(() => { renderRef.current(); }, [guideGap]);
  useEffect(() => {
    onStatusChange?.({ kind: state.kind, hasFrame, paused, stalled, renderer });
  }, [state.kind, hasFrame, paused, stalled, renderer, onStatusChange]);
  useEffect(() => {
    const timer = setInterval(() => setStalled(Boolean(session && hasFrame && !paused && performance.now() - lastFrameAt.current > 3_000)), 1_000);
    return () => clearInterval(timer);
  }, [session, hasFrame, paused]);
  const fitScale = (bins: Float32Array) => {
    const scale = spectrumDisplayScale(bins);
    if (!scale) return false;
    floorRef.current = scale.floorDb;
    rangeRef.current = scale.rangeDb;
    setFloorDb(scale.floorDb);
    setRangeDb(scale.rangeDb);
    scaleCallback.current?.(scale);
    renderRef.current();
    return true;
  };
  fitScaleRef.current = fitScale;
  const autoScale = () => { if (latestBinsRef.current) fitScale(latestBinsRef.current); };
  const retryGraphics = () => {
    setState({ kind: "checking", message: "Recreating the spectrum display…" });
    setDisplayedGeneration(undefined);
    setFftSize(renderer === "canvas2d" ? FFT_SIZE : requestedFftSize ?? FFT_SIZE);
    setGpuAttempt((attempt) => attempt + 1);
  };
  const labels = useMemo(() => session ? spectrumFrequencyTicks(session.hardwareCenterFrequencyHz, session.actualSampleRateHz, displayWidth) : [], [session, displayWidth]);
  const markerPositionPercent = session
    ? Math.max(
        0,
        Math.min(
          100,
          (0.5 +
            (session.selectedChannelFrequencyHz -
              session.hardwareCenterFrequencyHz) /
              session.actualSampleRateHz) *
            100,
        ),
      )
    : 50;
  const passbandDisplay = useMemo(() => {
    if (!session) return undefined;
    const bands = channelPassbands(session)
      .map((band) => ({
        ...band,
        left: Math.max(
          0,
          Math.min(
            100,
            frequencyPercent(
              band.startFrequencyHz,
              session.hardwareCenterFrequencyHz,
              session.actualSampleRateHz,
            ),
          ),
        ),
        right: Math.max(
          0,
          Math.min(
            100,
            frequencyPercent(
              band.endFrequencyHz,
              session.hardwareCenterFrequencyHz,
              session.actualSampleRateHz,
            ),
          ),
        ),
      }))
      .filter((band) => band.right > band.left)
      .sort((left, right) => left.left - right.left);
    if (!bands.length) return undefined;
    const dimmed: { left: number; right: number }[] = [];
    let cursor = 0;
    for (const band of bands) {
      if (band.left > cursor) dimmed.push({ left: cursor, right: band.left });
      cursor = Math.max(cursor, band.right);
    }
    if (cursor < 100) dimmed.push({ left: cursor, right: 100 });
    const summary =
      session.mode === "AIS"
        ? `AIS 1 / AIS 2 · ${formatPassbandWidth(bands[0]!.endFrequencyHz - bands[0]!.startFrequencyHz)} each`
        : `${session.mode} · ${formatPassbandWidth(bands[0]!.endFrequencyHz - bands[0]!.startFrequencyHz)}${session.mode === "USB" ? " upper sideband" : session.mode === "LSB" ? " lower sideband" : ""}`;
    return { bands, dimmed, summary };
  }, [session]);

  const graphicsGeneration = renderer === "canvas2d" || requestedFftSize ? session?.sessionGeneration : undefined;
  useEffect(() => {
    hoverFrameRef.current = undefined;
    let disposed = false;
    const size = fftSize;
    let canvasDisplay: CanvasSpectrum | undefined;
    let surface: GpuSpectrumSurface | undefined;
    let surfaceStarting = false;
    let surfaceFailed = false;
    let surfaceStatusAt = -Infinity;
    let lastSurfaceDraw = -Infinity;
    let surfaceAnimation: number | undefined;
    let surfaceSubmissionPending = false;
    let surfaceRedraw = false;
    let markerAnimation: number | undefined;
    let previousSession = sessionRef.current;
    const markerMotion = new SurfaceMarkerMotion();
    let animationFrame: number | undefined;
    let fft: GpuSpectrum | undefined;
    let gpuTap: GpuAnalysisTap | undefined;
    let detachGpuTap: (() => void) | undefined;
    let gpuFrames = 0;
    let totalLatency = 0;
    let maxLatency = 0;
    let device: GPUDevice | undefined;
    let context: GPUCanvasContext | null = null;
    let spectrumBuffer: GPUBuffer | undefined;
    let historyBuffer: GPUBuffer | undefined;
    let displayBuffer: GPUBuffer | undefined;
    let waterfallPipeline: GPURenderPipeline | undefined;
    let spectrumPipeline: GPURenderPipeline | undefined;
    let markerPipeline: GPURenderPipeline | undefined;
    let bindGroup: GPUBindGroup | undefined;
    let latestFrame: SpectrumFrame | undefined;
    let resizeObserver: ResizeObserver | undefined;
    let gpuFailed = false;
    const renderWhenVisible = () => {
      if (document.visibilityState === "visible") renderRef.current();
    };
    const history = new WaterfallHistory(HISTORY_ROWS, size);
    history.reset(sessionRef.current?.sessionGeneration ?? 0);
    const gapRow = new Float32Array(size).fill(GAP_LEVEL_DB);
    const data = new ArrayBuffer(128);
    const colors = new Float32Array(data, 32);
    const view = new DataView(data);
    let cssWidth = 0;
    let cssHeight = 0;
    let statusAt = -Infinity;
    const shouldUpdateStatus = () => {
      const now = performance.now();
      if (!visibleRef.current || now - statusAt < 250) return false;
      statusAt = now;
      return true;
    };

    const writeDisplay = () => {
      if (!device || !displayBuffer) return;
      const currentSession = sessionRef.current;
      const selected =
        currentSession?.selectedChannelFrequencyHz ??
        latestFrame?.centerFrequencyHz ??
        0;
      const center =
        latestFrame?.centerFrequencyHz ??
        currentSession?.hardwareCenterFrequencyHz ??
        selected;
      const rate =
        latestFrame?.sampleRateHz ?? currentSession?.actualSampleRateHz ?? 1;
      view.setFloat32(
        0,
        Math.max(-1, Math.min(1, (2 * (selected - center)) / rate)),
        true,
      );
      view.setFloat32(4, floorRef.current, true);
      view.setFloat32(8, rangeRef.current, true);
      view.setFloat32(12, cssHeight > 0 ? Math.min(.5, guideGapRef.current / cssHeight) : 0, true);
      view.setUint32(16, history.state.nextWriteRow, true);
      view.setUint32(20, history.state.count, true);
      colors.set(paletteRef.current.uniforms);
      device.queue.writeBuffer(displayBuffer, 0, data);
    };
    const render = () => {
      if (disposed || !visibleRef.current) return;
      if (canvasDisplay) {
        const drawCanvas = () => {
          if (disposed || !visibleRef.current) return;
          try {
            canvasDisplay?.render(
              cssWidth, cssHeight, Math.max(1, window.devicePixelRatio || 1),
              floorRef.current, rangeRef.current, paletteRef.current,
              guideGapRef.current,
            );
            if (latestFrame) hoverFrameRef.current = {
              center: latestFrame.centerFrequencyHz, rate: latestFrame.sampleRateHz,
              bins: latestFrame.bins, columns: Math.min(canvasRef.current?.width ?? 1, FFT_SIZE),
              floor: floorRef.current, range: rangeRef.current,
            };
          } catch (error) {
            setState({ kind: "error", message: `Canvas2D rendering failed: ${error instanceof Error ? error.message : String(error)}` });
          }
        };
        // Commit the final accepted frame before Pause returns. A pending RAF
        // must not change the frozen plot later or disagree with Auto scale.
        if (pausedRef.current) {
          if (animationFrame !== undefined) cancelAnimationFrame(animationFrame);
          animationFrame = undefined;
          drawCanvas();
        } else if (animationFrame === undefined) {
          animationFrame = requestAnimationFrame(() => {
            animationFrame = undefined;
            drawCanvas();
          });
        }
        return;
      }
      const canvas = canvasRef.current;
      if (
        !visibleRef.current ||
        !canvas ||
        !device ||
        !context ||
        !waterfallPipeline ||
        !spectrumPipeline ||
        !markerPipeline ||
        !bindGroup
      )
        return;
      try {
      if (surfacePreferencesRef.current.view === "3d" && !requestedFftSize && !surface && !surfaceStarting && !surfaceFailed) {
        surfaceStarting = true;
        setSurfaceState("loading");
        const currentDevice = device;
        void import("./gpuSpectrumSurface").then(module => module.GpuSpectrumSurface.create(currentDevice, navigator.gpu.getPreferredCanvasFormat(), spectrumBuffer!, size)).then(created => {
          if (disposed || gpuFailed || device !== currentDevice) { created.dispose(); return; }
          surface = created;
          setSurfaceState("ready");
          render();
        }).catch(error => {
          if (!disposed && !gpuFailed) {
            surfaceFailed = true;
            setSurfaceState(`3D unavailable — showing 2D. ${error instanceof Error ? error.message : String(error)}`);
          }
        });
      }
      const useSurface = Boolean(surface && surfaceActiveRef.current);
      if (useSurface && surfaceSubmissionPending) {
        surfaceRedraw = true;
        return;
      }
      // Coalesce incoming redraws without touching analysis publication/credits.
      if (useSurface && !pausedRef.current && performance.now() - lastSurfaceDraw < 1000 / 30) {
        if (surfaceAnimation === undefined) surfaceAnimation = requestAnimationFrame(() => {
          surfaceAnimation = undefined;
          render();
        });
        return;
      }
      if (surfaceAnimation !== undefined) cancelAnimationFrame(surfaceAnimation);
      surfaceAnimation = undefined;
      lastSurfaceDraw = performance.now();
      const ratio = useSurface ? Math.min(2, Math.max(1, window.devicePixelRatio || 1),
        SURFACE_MAX_DIMENSION / Math.max(1, cssWidth, cssHeight),
        device.limits.maxTextureDimension2D / Math.max(1, cssWidth, cssHeight)) : Math.max(1, window.devicePixelRatio || 1);
      const width = Math.min(
        Math.max(1, Math.round(cssWidth * ratio)),
        useSurface ? SURFACE_MAX_DIMENSION : device.limits.maxTextureDimension2D,
        device.limits.maxTextureDimension2D,
      );
      const height = Math.min(
        Math.max(1, Math.round(cssHeight * ratio)),
        useSurface ? SURFACE_MAX_DIMENSION : device.limits.maxTextureDimension2D,
        device.limits.maxTextureDimension2D,
      );
      if (canvas.width !== width) canvas.width = width;
      if (canvas.height !== height) canvas.height = height;
      writeDisplay();
      const encoder = device.createCommandEncoder({
        label: "RF spectrum and waterfall commands",
      });
      const texture = context.getCurrentTexture();
      const target = texture.createView();
      if (!(useSurface && surfacePreferencesRef.current.layout === "combined")) {
      const pass = encoder.beginRenderPass({
        colorAttachments: [
          {
            view: target,
            clearValue: { r: paletteRef.current.background[0], g: paletteRef.current.background[1], b: paletteRef.current.background[2], a: 1 },
            loadOp: "clear",
            storeOp: "store",
          },
        ],
      });
      pass.setBindGroup(0, bindGroup);
      if (!useSurface) {
        pass.setPipeline(waterfallPipeline);
        pass.draw(3);
      }
      if (latestFrame && !(useSurface && surfacePreferencesRef.current.layout === "combined")) {
        if (useSurface) {
          pass.setViewport(0, 0, width, height * SURFACE_TRACE_FRACTION / .38, 0, 1);
          pass.setScissorRect(0, 0, width, Math.max(1, Math.floor(height * SURFACE_TRACE_FRACTION)));
        }
        pass.setPipeline(spectrumPipeline);
        pass.draw(size);
        pass.setPipeline(markerPipeline);
        pass.draw(2);
      }
      pass.end();
      }
      if (useSurface && surface) {
        const current = sessionRef.current;
        const center = latestFrame?.centerFrequencyHz ?? current?.hardwareCenterFrequencyHz ?? 0;
        const rate = latestFrame?.sampleRateHz ?? current?.actualSampleRateHz ?? 1;
        const fraction = (hz: number) => .5 + (hz - center) / rate;
        const edges = current ? channelPassbands(current).flatMap(band => [fraction(band.startFrequencyHz), fraction(band.endFrequencyHz)]) : [];
        const bands = [edges[0] ?? -10, edges[1] ?? -10, edges[2] ?? -10, edges[3] ?? -10];
        markerMotion.set([fraction(current?.selectedChannelFrequencyHz ?? center),...bands],performance.now(),false);
        const markers = markerMotion.advance(performance.now());
        surface.encode(encoder, texture, width, height, height * (surfacePreferencesRef.current.layout === "combined" ? 0 : SURFACE_TRACE_FRACTION) + guideGapRef.current * height / Math.max(1, cssHeight), (surfacePreferencesRef.current.layout === "combined" ? 112 : 48) * height / Math.max(1, cssHeight),
          floorRef.current, rangeRef.current, surfacePreferencesRef.current, paletteRef.current,
          markers[0]!, markers.slice(1), width / Math.max(1,cssWidth));
        canvas.dataset.surfaceScenes = String(surface.sceneDraws);
        canvas.dataset.surfaceMarkers = String(surface.markerDraws);
        canvas.dataset.surfaceMarkerX = String(markers[0]);
        if (markerMotion.moving(performance.now()) && markerAnimation === undefined) markerAnimation=requestAnimationFrame(() => {
          markerAnimation=undefined; render();
        });
        if (pausedRef.current || performance.now() - surfaceStatusAt > 250) {
          surfaceStatusAt = performance.now();
          setSurfaceDuration(surface.history.duration(surfacePreferencesRef.current.seconds));
        }
      }
      device.queue.submit([encoder.finish()]);
      if (useSurface) {
        surfaceSubmissionPending = true;
        canvas.dataset.surfacePending = "true";
        const submittedDevice = device;
        // Keep at most one terrain submission in flight. Analysis/history keep
        // accepting bounded rows; a slow GPU draws only the newest held state.
        void submittedDevice.queue.onSubmittedWorkDone().then(() => {
          if (disposed || gpuFailed || device !== submittedDevice) return;
          surfaceSubmissionPending = false;
          canvas.dataset.surfacePending = "false";
          if (surfaceRedraw) { surfaceRedraw = false; render(); }
        }).catch(error => {
          if (!disposed && !gpuFailed) fallbackToCanvas(`GPU completion failed: ${error instanceof Error ? error.message : String(error)}`);
        });
      } else canvas.dataset.surfacePending = "false";
      if (latestFrame) hoverFrameRef.current = {
        center: latestFrame.centerFrequencyHz, rate: latestFrame.sampleRateHz,
        // Experimental GPU FFT does not expose the plotted bins on the CPU.
        bins: fft ? undefined : latestFrame.bins, columns: size,
        floor: floorRef.current, range: rangeRef.current,
      };
      } catch (error) {
        defaultDiagnosticRecorder.record({ area: "graphics", code: "WEBGPU_RENDER_FAILURE", severity: "warning", operation: "render", error });
        fallbackToCanvas(`WebGPU rendering failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    };
    renderRef.current = render;

    surfacePickRef.current = (x,y,width,height) => surface?.pick(x,y,width,height,latestFrame?.bins);
    sessionChangeRef.current = next => {
      const old = previousSession;
      previousSession = next;
      if (!next || !old || old.sessionGeneration !== next.sessionGeneration ||
        !channelOnlyDisplayChange(old,next)) {
        const compatible = channelOnlyDisplayChange(old,next);
        history.reset(next?.sessionGeneration ?? 0);
        if (compatible && next && latestFrame) {
          surface?.history.continueGeneration(next.sessionGeneration);
          setDisplayedGeneration(next.sessionGeneration);
          const coordinates = guideCoordinatesRef.current;
          if (coordinates) { const updated = {...coordinates,generation:next.sessionGeneration}; guideCoordinatesRef.current=updated; setGuideCoordinates(updated); }
        } else {
          surface?.reset(); latestFrame=undefined; latestBinsRef.current=undefined;
          hoverFrameRef.current=undefined; setDisplayedGeneration(undefined); setSurfaceDuration(0);
        }
      }
      if (next && latestFrame) {
        const fraction = (hz:number) => .5+(hz-latestFrame!.centerFrequencyHz)/latestFrame!.sampleRateHz;
        const edges=channelPassbands(next).flatMap(band=>[fraction(band.startFrequencyHz),fraction(band.endFrequencyHz)]);
        markerMotion.set([fraction(next.selectedChannelFrequencyHz),edges[0]??-10,edges[1]??-10,edges[2]??-10,edges[3]??-10],performance.now(),!window.matchMedia("(prefers-reduced-motion: reduce)").matches);
      }
      if (markerAnimation !== undefined) cancelAnimationFrame(markerAnimation);
      markerAnimation=undefined; render();
    };

    const unsubscribe = pipeline.subscribe((frame, frames) => {
      if (disposed || frame.sessionGeneration !== (sessionRef.current?.sessionGeneration ?? 0)) return;
      if (!pausedRef.current) surface?.accept(frames);
      else surface?.history.breakContinuity();
      if (canvasDisplay) {
        if (pausedRef.current) return;
        const accepted = canvasDisplay.accept(frames);
        if (!accepted) return;
        latestFrame = accepted;
        latestBinsRef.current = accepted.bins;
        lastFrameAt.current = performance.now();
        setDisplayedGeneration(accepted.sessionGeneration);
        rememberGuideCoordinates(accepted);
        render();
        if (shouldUpdateStatus()) setState({ kind: "ready", message: `Canvas2D live · ${(accepted.sampleIndex / accepted.sampleRateHz).toFixed(2)} s on source sample clock · ${fallbackReason}` });
        return;
      }
      if (!pausedRef.current) latestBinsRef.current = frame.bins;
      if (
        fft ||
        gpuFailed ||
        !device ||
        !spectrumBuffer ||
        !historyBuffer ||
        frame.bins.length !== size ||
        pausedRef.current
      )
        return;
      latestFrame = frame;
      rememberGuideCoordinates(frame);
      lastFrameAt.current = performance.now();
      setDisplayedGeneration(frame.sessionGeneration);
      device.queue.writeBuffer(spectrumBuffer, 0, frame.bins);
      for (const retainedFrame of frames) {
        for (const row of history.append(retainedFrame)) {
          device.queue.writeBuffer(
            historyBuffer,
            row.row * size * Float32Array.BYTES_PER_ELEMENT,
            row.bins ?? gapRow,
          );
        }
      }
      render();
      if (shouldUpdateStatus())
        setState({
          kind: "ready",
          message:
            frame.droppedFramesBefore > 0
              ? `WebGPU live · ${frame.droppedFramesBefore} display frame(s) skipped and marked in history`
              : `WebGPU live · ${(frame.sampleIndex / frame.sampleRateHz).toFixed(2)} s on source sample clock`,
        });
    });

    async function initialize() {
      const initializationStarted = performance.now();
      const canvas = canvasRef.current;
      if (renderer === "canvas2d") {
        try {
          const { CanvasSpectrum } = await import("./canvasSpectrum");
          if (disposed) return;
          if (!canvas) throw new Error("Spectrum canvas is unavailable.");
          const canvasContext = canvas.getContext("2d", { alpha: false });
          if (!canvasContext) throw new Error("This browser could not create a Canvas2D context.");
          canvasDisplay = new CanvasSpectrum(canvasContext, sessionRef.current?.sessionGeneration ?? 0);
          cssWidth = canvas.clientWidth;
          setDisplayWidth(cssWidth);
          cssHeight = canvas.clientHeight;
          resizeObserver = new ResizeObserver((entries) => {
            const entry = entries.find((item) => item.target === canvas);
            if (entry) {
              cssWidth = entry.contentRect.width;
              setDisplayWidth(cssWidth);
              cssHeight = entry.contentRect.height;
            }
            render();
          });
          resizeObserver.observe(canvas);
          render();
          setState({ kind: "ready", message: `Canvas2D ready · waiting for RF I/Q spectrum frames · ${fallbackReason}` });
        } catch (error) {
          setState({ kind: "error", message: `Canvas2D display unavailable: ${error instanceof Error ? error.message : String(error)}` });
        }
        return;
      }
      if (!canvas || !("gpu" in navigator) || !navigator.gpu) {
        fallbackToCanvas("WebGPU is unavailable.");
        return;
      }
      try {
        const adapter = await navigator.gpu.requestAdapter();
        if (disposed) return;
        if (!adapter) {
          fallbackToCanvas("No compatible GPU adapter was found.");
          return;
        }
        device = await adapter.requestDevice();
        if (disposed) {
          device.destroy();
          return;
        }
        const requestedDevice = device;
        void requestedDevice.lost.then((info) => {
          if (disposed || device !== requestedDevice) return;
          releaseGpuResources(false);
          defaultDiagnosticRecorder.record({
            area: "graphics",
            code: "WEBGPU_DEVICE_LOST",
            severity: "error",
            operation: "render",
            safeMessage: info.reason || "unknown",
            autoSubmitEligible: true,
          });
          fallbackToCanvas(`The GPU device was lost (${info.reason || "unknown"}).`);
        });
        device.addEventListener("uncapturederror", onUncapturedError);
        context = canvas.getContext("webgpu") as GPUCanvasContext | null;
        if (!context)
          throw new Error(
            "This browser could not create a WebGPU canvas context.",
          );
        const format = navigator.gpu.getPreferredCanvasFormat();
        context.configure({ device, format, alphaMode: "opaque", usage: 0x10 | 0x2 });
        const module = device.createShaderModule({
          code: spectrumShader(size),
          label: "RF spectrum and waterfall shader",
        });
        const compilation = await module.getCompilationInfo();
        if (disposed || gpuFailed || !device) return;
        const shaderErrors = compilation.messages.filter(
          (message) => message.type === "error",
        );
        if (shaderErrors.length)
          throw new Error(
            shaderErrors.map((message) => message.message).join("; "),
          );
        const layout = device.createBindGroupLayout({
          entries: [
            {
              binding: 0,
              visibility: GPU_VERTEX_STAGE,
              buffer: { type: "read-only-storage" },
            },
            {
              binding: 1,
              visibility: GPU_FRAGMENT_STAGE,
              buffer: { type: "read-only-storage" },
            },
            {
              binding: 2,
              visibility: GPU_VERTEX_STAGE | GPU_FRAGMENT_STAGE,
              buffer: { type: "uniform" },
            },
          ],
        });
        const pipelineLayout = device.createPipelineLayout({
          bindGroupLayouts: [layout],
        });
        waterfallPipeline = device.createRenderPipeline({
          label: "waterfall pipeline",
          layout: pipelineLayout,
          vertex: { module, entryPoint: "fullscreenVertex" },
          fragment: {
            module,
            entryPoint: "waterfallFragment",
            targets: [{ format }],
          },
        });
        spectrumPipeline = device.createRenderPipeline({
          label: "RF spectrum pipeline",
          layout: pipelineLayout,
          vertex: { module, entryPoint: "spectrumVertex" },
          fragment: {
            module,
            entryPoint: "spectrumFragment",
            targets: [{ format }],
          },
          primitive: { topology: "line-strip" },
        });
        markerPipeline = device.createRenderPipeline({
          label: "selected frequency marker pipeline",
          layout: pipelineLayout,
          vertex: { module, entryPoint: "markerVertex" },
          fragment: {
            module,
            entryPoint: "markerFragment",
            targets: [{ format }],
          },
          primitive: { topology: "line-list" },
        });
        spectrumBuffer = device.createBuffer({
          label: "spectrum levels",
          size: size * 4,
          usage: GPU_BUFFER_STORAGE | GPU_BUFFER_COPY_DST,
        });
        historyBuffer = device.createBuffer({
          label: "circular waterfall power history",
          size: size * HISTORY_ROWS * 4,
          usage: GPU_BUFFER_STORAGE | GPU_BUFFER_COPY_DST,
        });
        displayBuffer = device.createBuffer({
          label: "display controls",
          size: 128,
          usage: GPU_BUFFER_UNIFORM | GPU_BUFFER_COPY_DST,
        });
        device.queue.writeBuffer(
          historyBuffer,
          0,
          new Float32Array(size * HISTORY_ROWS).fill(GAP_LEVEL_DB),
        );
        bindGroup = device.createBindGroup({
          layout,
          entries: [
            { binding: 0, resource: { buffer: spectrumBuffer } },
            { binding: 1, resource: { buffer: historyBuffer } },
            { binding: 2, resource: { buffer: displayBuffer } },
          ],
        });
        if (requestedFftSize && size === requestedFftSize) {
          try {
            fft = await GpuSpectrum.create(device, size);
            if (disposed || gpuFailed) {
              fft.dispose();
              return;
            }
            const startupMs = performance.now() - initializationStarted;
            setFftMessage(
              `Experimental GPU FFT · ${size} bins · ${startupMs.toFixed(2)} ms startup · wall-clock timing (no GPU timestamps)`,
            );
            gpuTap = new GpuAnalysisTap(
              size,
              sessionRef.current?.sessionGeneration ?? 0,
              async (input, frame) => {
                if (
                  pausedRef.current ||
                  disposed ||
                  gpuFailed ||
                  !device ||
                  !fft ||
                  !spectrumBuffer ||
                  !historyBuffer
                )
                  return;
                const started = performance.now();
                const currentDevice = device;
                const encoder = device.createCommandEncoder({
                  label: "FFT upload-compute-history",
                });
                fft.encode(input, encoder);
                latestFrame = frame;
                rememberGuideCoordinates(frame);
                lastFrameAt.current = performance.now();
      setDisplayedGeneration(frame.sessionGeneration);
                encoder.copyBufferToBuffer(
                  fft.output,
                  0,
                  spectrumBuffer,
                  0,
                  size * 4,
                );
                for (const row of history.append(frame)) {
                  if (row.kind === "gap")
                    currentDevice.queue.writeBuffer(
                      historyBuffer,
                      row.row * size * 4,
                      gapRow,
                    );
                  else
                    encoder.copyBufferToBuffer(
                      fft.output,
                      0,
                      historyBuffer,
                      row.row * size * 4,
                      size * 4,
                    );
                }
                currentDevice.queue.submit([encoder.finish()]);
                render();
                await currentDevice.queue.onSubmittedWorkDone();
                if (disposed || gpuFailed) return;
                const latency = performance.now() - started;
                gpuFrames++;
                totalLatency += latency;
                maxLatency = Math.max(maxLatency, latency);
                if (shouldUpdateStatus()) {
                  setFftMessage(
                    `Experimental GPU FFT · ${size} bins · ${startupMs.toFixed(2)} ms startup · upload + compute + render completion, wall clock: ${(totalLatency / gpuFrames).toFixed(2)} ms mean / ${maxLatency.toFixed(2)} ms max · ${gpuFrames} frames · WASM reference also active`,
                  );
                  setState({
                    kind: "ready",
                    message: `WebGPU FFT live · ${(frame.sampleIndex / frame.sampleRateHz).toFixed(2)} s source clock · ${frame.droppedFramesBefore} skipped input/gap event(s)`,
                  });
                }
              },
              (error) => disableFft(error),
            );
            detachGpuTap = pipeline.attachGpuTap(
              (block) => gpuTap?.accept(block),
              (block) => gpuTap?.accept(block),
            );
          } catch (error) {
            disableFft(error);
          }
        }
        cssWidth = canvas.clientWidth;
        setDisplayWidth(cssWidth);
        cssHeight = canvas.clientHeight;
        resizeObserver = new ResizeObserver((entries) => {
          const entry = entries.find((item) => item.target === canvas);
          if (entry) {
            cssWidth = entry.contentRect.width;
            setDisplayWidth(cssWidth);
            cssHeight = entry.contentRect.height;
          }
          render();
        });
        resizeObserver.observe(canvas);
        document.addEventListener("visibilitychange", renderWhenVisible);
        render();
        if (gpuFailed || disposed) return;
        setState({
          kind: "ready",
          message: "WebGPU ready · waiting for RF I/Q spectrum frames",
        });
      } catch (error) {
        if (!disposed) {
          releaseGpuResources(true);
          defaultDiagnosticRecorder.record({
            area: "graphics",
            code: "WEBGPU_INITIALIZATION_FAILURE",
            severity: "warning",
            operation: "initialize",
            error,
          });
          fallbackToCanvas(`WebGPU initialization failed: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
    }
    void initialize();
    return () => {
      disposed = true;
      hoverFrameRef.current = undefined;
      renderRef.current = () => undefined;
      sessionChangeRef.current = () => undefined; surfacePickRef.current = () => undefined;
      if (markerAnimation !== undefined) cancelAnimationFrame(markerAnimation);
      unsubscribe();
      if (animationFrame !== undefined) cancelAnimationFrame(animationFrame);
      if (surfaceAnimation !== undefined) cancelAnimationFrame(surfaceAnimation);
      releaseGpuResources(true);
    };
    function fallbackToCanvas(reason: string): void {
      if (disposed) return;
      releaseGpuResources(true);
      setFallbackReason(reason);
      setRenderer("canvas2d");
      setFftSize(FFT_SIZE);
      latestBinsRef.current = undefined;
      setDisplayedGeneration(undefined);
      setState({ kind: "checking", message: "Preparing Canvas2D spectrum display…" });
      if (requestedFftSize) setFftMessage("Experimental GPU FFT unavailable; using CPU/WASM spectrum frames.");
    }
    function disableFft(error: unknown): void {
      if (disposed || gpuFailed) return;
      gpuTap?.dispose();
      detachGpuTap?.();
      fft?.dispose();
      fft = undefined;
      history.reset(sessionRef.current?.sessionGeneration ?? 0);
      latestFrame = undefined;
      setFftMessage(
        `Experimental GPU FFT disabled: ${error instanceof Error ? error.message : String(error)}. Using CPU/WASM spectrum.`,
      );
      if (size !== FFT_SIZE) setFftSize(FFT_SIZE);
    }
    function onUncapturedError(event: GPUUncapturedErrorEvent): void {
      if (!disposed) {
        releaseGpuResources(true);
        defaultDiagnosticRecorder.record({
          area: "graphics",
          code: "WEBGPU_UNCAPTURED_ERROR",
          severity: "error",
          operation: "render",
          error: event.error,
          autoSubmitEligible: true,
        });
        fallbackToCanvas(`WebGPU rendering error: ${event.error.message}`);
      }
    }
    function releaseGpuResources(destroyDevice: boolean): void {
      gpuFailed = true;
      surface?.dispose();
      surface = undefined;
      if (surfaceAnimation !== undefined) cancelAnimationFrame(surfaceAnimation);
      surfaceAnimation = undefined;
      gpuTap?.dispose();
      detachGpuTap?.();
      fft?.dispose();
      fft = undefined;
      if (requestedFftSize && !disposed)
        setFftMessage(
          "Experimental GPU FFT disabled with graphics; CPU/WASM analysis continues. Retry graphics to recover.",
        );
      resizeObserver?.disconnect();
      resizeObserver = undefined;
      document.removeEventListener("visibilitychange", renderWhenVisible);
      const currentDevice = device;
      currentDevice?.removeEventListener("uncapturederror", onUncapturedError);
      spectrumBuffer?.destroy();
      historyBuffer?.destroy();
      displayBuffer?.destroy();
      context?.unconfigure();
      if (destroyDevice) currentDevice?.destroy();
      spectrumBuffer = undefined;
      historyBuffer = undefined;
      displayBuffer = undefined;
      waterfallPipeline = undefined;
      spectrumPipeline = undefined;
      markerPipeline = undefined;
      bindGroup = undefined;
      context = null;
      device = undefined;
    }
  }, [
    gpuAttempt,
    renderer,
    fallbackReason,
    pipeline,
    requestedFftSize,
    graphicsGeneration,
    fftSize,
  ]);

  const tuneFrequency = (frequency: number, free = false) => {
    if (!session || !onTune) return;
    const snapped = snapChannels && !free
      ? snapChannelFrequency(frequency, session.mode, rasterRegion) : frequency;
    const margin = session.actualSampleRateHz / 2 - session.channelBandwidthHz / 2;
    const target = Math.abs(snapped - session.hardwareCenterFrequencyHz) <= margin ? snapped : frequency;
    if (Math.abs(target-session.selectedChannelFrequencyHz) >= .5) onTune(target);
  };
  const tuneFromPosition = (event: MouseEvent<HTMLElement>) => {
    if (!session) return;
    const bounds = event.currentTarget.getBoundingClientRect();
    tuneFrequency(frequencyForPixel(event.clientX - bounds.left, bounds.width,
      session.hardwareCenterFrequencyHz, session.actualSampleRateHz), event.altKey);
  };
  const tuneFromClick = (event: MouseEvent<HTMLCanvasElement>) => {
    const bounds = event.currentTarget.getBoundingClientRect();
    if (surfaceActiveRef.current && (surfacePreferencesRef.current.layout === "combined" ||
      event.clientY - bounds.top >= bounds.height * SURFACE_TRACE_FRACTION)) {
      if (!session || !hasFrame) return;
      const fraction=surfacePickRef.current(event.clientX-bounds.left,event.clientY-bounds.top,bounds.width,bounds.height);
      if (fraction !== undefined) tuneFrequency(session.hardwareCenterFrequencyHz+(fraction-.5)*session.actualSampleRateHz,event.altKey);
      return;
    }
    tuneFromPosition(event);
  };
  const updatePaused = () => {
    pausedRef.current = !paused;
    setPaused(!paused);
    renderRef.current();
  };

  return (
    <section className="graphics-panel" aria-labelledby="graphics-heading">
      <div className="panel-heading spectrum-heading">
        <div className="stage-heading">
          <span aria-hidden="true">02</span>
          <div>
            <p>Analyze</p>
            <h2 id="graphics-heading">Spectrum & waterfall</h2>
          </div>
        </div>
        <div className="spectrum-view-controls">
          <div className="spectrum-view-choice" role="group" aria-label="Spectrum view">
            <InstrumentButton type="button" className="secondary" aria-pressed={surfacePreferences.view === "2d"}
              onClick={() => changeSurface({ view: "2d" })}>2D waterfall</InstrumentButton>
            <InstrumentButton type="button" className="secondary" aria-pressed={surfacePreferences.view === "3d"}
              onClick={() => changeSurface({ view: "3d" })}>3D history</InstrumentButton>
          </div>
          {surfacePreferences.view === "3d" && !surfaceActive && <p className="surface-notice" role="status">
            {renderer === "canvas2d" ? "3D unavailable — showing 2D. A compatible GPU is needed." : requestedFftSize ?
              "3D unavailable with experimental GPU FFT — showing 2D." : surfaceState.startsWith("3D unavailable") ?
                "3D unavailable — showing 2D. Retry graphics in Display settings." : "Preparing 3D history…"}
          </p>}
        </div>
        <Suspense fallback={null}><BandGuideFeature canvas={canvasRef} width={displayWidth}
          coordinates={validGuideCoordinates} selectedHz={session?.selectedChannelFrequencyHz ?? 0}
          onPlanChange={setRasterRegion} onHeightChange={setGuideGap} /></Suspense>
        <WorkspaceToolDialog title="Display settings" icon="sliders" open={displayOpen} onOpenChange={setDisplayOpen} placement="spectrum" className="spectrum-display-trigger" footer="Display changes do not affect receiver gain.">
          <div className="display-settings">
        <label className="spectrum-hover-toggle receiver-auto-center receiver-tool-toggle">
          <input type="checkbox" disabled={surfaceCombined} checked={hoverEnabled} onChange={event => {
            const enabled = event.currentTarget.checked;
            setHoverEnabled(enabled);
            try { localStorage.setItem("browsersdr.spectrum-hover.v1", enabled ? "on" : "off"); } catch { /* Keep the in-tab choice when storage is unavailable. */ }
          }} /><span className="receiver-switch-track" aria-hidden="true" />
          Hover frequency guide
        </label>
        {surfaceCombined && <small>For trace hover readouts, choose the separate spectrum layout.</small>}
        <label className="display-note receiver-auto-center receiver-tool-toggle">
          <input type="checkbox" checked={snapChannels} onChange={event => {
            const enabled = event.currentTarget.checked; setSnapChannels(enabled);
            try { localStorage.setItem("browsersdr.channel-snap.v1", enabled ? "on" : "off"); } catch { /* Keep in-tab preference. */ }
          }} /><span className="receiver-switch-track" aria-hidden="true" />
          Snap spectrum clicks to broadcast channels · {rasterRegion} · Alt-click for free tuning
        </label>
        <div className="display-controls">
          <label>
            Display renderer
            <select aria-label="Display renderer" value={renderer} onChange={(event) => {
              const next = event.currentTarget.value as "webgpu" | "canvas2d";
              setRenderer(next);
              setFallbackReason(next === "canvas2d" ? "Compatibility display selected." : "");
              setFftSize(next === "canvas2d" ? FFT_SIZE : requestedFftSize ?? FFT_SIZE);
              setDisplayedGeneration(undefined);
              latestBinsRef.current = undefined;
              setState({ kind: "checking", message: "Preparing spectrum display…" });
              setFftMessage(next === "canvas2d" && requestedFftSize ? "Experimental GPU FFT unavailable; using CPU/WASM spectrum frames." : "");
              setGpuAttempt(attempt => attempt + 1);
            }}>
              <option value="webgpu">WebGPU (automatic fallback)</option>
              <option value="canvas2d">Compatibility (Canvas2D)</option>
            </select>
          </label>
          <label>
            Floor <output>{floorDb} dB</output>
            <input
              type="range"
              aria-label="Spectrum floor"
              min="-120"
              max="-30"
              step="1"
              value={floorDb}
              onChange={(event) => {
                const value = event.currentTarget.valueAsNumber;
                floorRef.current = value;
                changeScaleMode(false);
                setFloorDb(value);
                onDisplaySettingsChange?.({ floorDb: value, rangeDb });
                renderRef.current();
              }}
            />
          </label>
          <label>
            Range <output>{rangeDb} dB</output>
            <input
              type="range"
              aria-label="Spectrum range"
              min="20"
              max="120"
              step="1"
              value={rangeDb}
              onChange={(event) => {
                const value = event.currentTarget.valueAsNumber;
                rangeRef.current = value;
                changeScaleMode(false);
                setRangeDb(value);
                onDisplaySettingsChange?.({ floorDb, rangeDb: value });
                renderRef.current();
              }}
            />
          </label>
        </div>
        {surfacePreferences.view === "3d" && <>
        <label className="surface-layout-setting">3D layout
          <select aria-label="3D layout" value={surfacePreferences.layout}
            onChange={event => changeSurface({ layout: event.currentTarget.value as SpectrumSurfaceSettings["layout"] })}>
            <option value="combined">Combined spectrum & history</option>
            <option value="separate">Separate spectrum & history</option>
          </select>
        </label><div className="surface-settings">
          <label>History window
            <select aria-label="3D history window" value={surfacePreferences.seconds} onChange={event => changeSurface({ seconds: Number(event.currentTarget.value) })}>
              <option value={4}>4 seconds</option><option value={8}>8 seconds</option><option value={10}>10 seconds</option><option value={16}>16 seconds</option>
            </select>
          </label>
          <label>Elevation <output>{surfacePreferences.elevation}°</output>
            <input type="range" aria-label="3D elevation" min={22} max={60} step={1} value={surfacePreferences.elevation}
              onChange={event => changeSurface({ elevation: event.currentTarget.valueAsNumber })} />
          </label>
          <label>Height <output>{surfacePreferences.height.toFixed(1)}×</output>
            <input type="range" aria-label="3D height exaggeration" min={.5} max={1.6} step={.1} value={surfacePreferences.height}
              onChange={event => changeSurface({ height: event.currentTarget.valueAsNumber })} />
          </label>
        </div>
        <label className="checkbox-label receiver-auto-center receiver-tool-toggle surface-depth-toggle">
          <input type="checkbox" role="switch" aria-label="Depth perspective" checked={surfacePreferences.perspective}
            onChange={event => changeSurface({ perspective: event.currentTarget.checked })} />
          <span className="receiver-switch-track" aria-hidden="true" />Depth perspective
        </label>
        <small className="surface-depth-help">{surfacePreferences.perspective ? "Older rows recede into the distance. The newest edge uses the full frequency width." : "All rows use the same frequency positions."}</small>
        <InstrumentButton type="button" className="secondary surface-reset" onClick={() => changeSurface({ elevation: 38, height: 1, perspective: true })}>Reset 3D camera</InstrumentButton>
        {surfacePreferences.view === "3d" && !surfaceActive && <InstrumentButton type="button" className="secondary surface-reset"
          onClick={() => { setRenderer("webgpu"); retryGraphics(); }}>Retry graphics</InstrumentButton>}</>}
        <small>
          <label className="checkbox-label receiver-auto-center receiver-tool-toggle"><input type="checkbox" checked={automaticScale} onChange={event => changeScaleMode(event.currentTarget.checked)} /><span className="receiver-switch-track" aria-hidden="true" />Auto scale on tune or rate change</label>
          Auto scale fits the current spectrum. Display changes do not affect
          receiver gain.
        </small>
</div>
        </WorkspaceToolDialog>
      </div>
      <div className="spectrum-display">
        <div
          className="spectrum-toolbar"
          aria-label="Spectrum and receiver controls"
        >
          <div className="spectrum-display-tools">
            <div className="spectrum-actions">
              <ActionButton
                type="button"
                className="secondary display-action"
                icon="sliders"
                title="Fit the current spectrum without changing receiver gain"
                disabled={!hasFrame || state.kind !== "ready"}
                disabledReason={state.kind !== "ready" ? "The spectrum display must be available first. Check diagnostics or retry graphics." : "Start reception and wait for spectrum samples."}
                onClick={autoScale}
              >
                Auto scale
              </ActionButton>
              <ActionButton
                type="button"
                className="secondary display-action display-pause"
                icon={paused ? "play" : "pause"}
                disabledLabel={paused ? "Resume display" : "Pause display"}
                aria-pressed={paused}
                disabled={state.kind !== "ready" || (!hasFrame && !paused)}
                disabledReason={state.kind !== "ready" ? "The spectrum display must be available first. Check diagnostics or retry graphics." : "Start reception and wait for spectrum samples."}
                onClick={updatePaused}
              >
                {paused ? "Resume display" : "Pause display"}
              </ActionButton>
            </div>
          </div>
          {tuningControls}
        </div>
        <div className={`canvas-frame${guideGap > 0 ? " has-band-guide" : ""}${surfaceActive ? " surface-active" : ""}${surfaceCombined ? " surface-combined" : ""}`} style={{"--band-guide-height":`${guideGap}px`, "--surface-trace-end":`${surfaceCombined ? 0 : SURFACE_TRACE_FRACTION * 100}%`, minHeight: surfaceActive ? 340 : undefined} as CSSProperties}>
          <canvas
            key={renderer}
            ref={canvasRef}
            width={960}
            height={560}
            aria-label={surfaceCombined ? "WebGPU combined live spectrum and 3D history; click the spectrum or grid to tune" : surfaceActive ? "WebGPU RF spectrum and 3D history; click the spectrum or grid to tune" : `${renderer === "canvas2d" ? "Canvas2D" : "WebGPU"} RF spectrum and waterfall plot; click to tune`}
            onClick={tuneFromClick}
          />
          {(state.kind !== "ready" || !hasFrame) && (
            <div className="plot-state" role="status">
              <strong>
                {state.kind === "error" || state.kind === "unsupported"
                  ? "Spectrum display unavailable"
                  : state.kind === "checking"
                    ? "Preparing spectrum display…"
                    : !session
                      ? "Start receiving to see the spectrum"
                      : replayEnded ? "Replay complete" : replayPaused ? "Replay paused" : !receiving ? "Ready to receive" : "Waiting for signal samples…"}
              </strong>
              <p>
                {state.kind === "error" || state.kind === "unsupported"
                  ? state.message
                  : !session
                    ? "Connect a receiver or choose the synthetic demo in Receiver."
                    : replayEnded ? "The recording has reached its end. Restart replay to view samples again." : replayPaused ? "Resume replay to continue the spectrum and waterfall." : !receiving ? "Start receiving to show the spectrum and waterfall." : "The spectrum will appear when samples reach the display. If this persists, check input delivery and receiver status."}
              </p>
              <div>
                {(state.kind === "error" || state.kind === "unsupported") && (
                  <InstrumentButton
                    type="button"
                    className="secondary retry-graphics"
                    onClick={retryGraphics}
                  >
                    Retry graphics
                  </InstrumentButton>
                )}
                {(state.kind === "error" || state.kind === "unsupported") &&
                  onOpenDiagnostics && (
                    <InstrumentButton
                      type="button"
                      className="secondary"
                      onClick={onOpenDiagnostics}
                    >
                      Check diagnostics
                    </InstrumentButton>
                  )}
                {!session && onOpenAcquire && (
                  <InstrumentButton
                    type="button"
                    className="secondary"
                    onClick={onOpenAcquire}
                  >
                    Open Receiver
                  </InstrumentButton>
                )}
              </div>
            </div>
          )}
          {passbandDisplay && hasFrame && state.kind === "ready" ? (
            <>
              <span className="receiver-center-line" aria-hidden="true" />
              <div className="passband-layer" aria-hidden="true">
                {passbandDisplay.dimmed.map((segment, index) => (
                  <span
                    key={`dim-${index}`}
                    className="passband-dim"
                    style={{
                      left: `${segment.left}%`,
                      width: `${segment.right - segment.left}%`,
                    }}
                  />
                ))}
                {passbandDisplay.bands.map((band) => (
                  <span
                    key={band.label}
                    className="passband-band"
                    style={{
                      left: `${band.left}%`,
                      width: `${band.right - band.left}%`,
                    }}
                  />
                ))}
              </div>
              <span
                className="selected-frequency-line"
                aria-hidden="true"
                style={{ left: `${markerPositionPercent}%` }}
              />
              <span className="passband-legend">
                Channel passband · {passbandDisplay.summary}
              </span>
            </>
          ) : null}
          <span className="plot-label spectrum-label">Spectrum</span>

          <span className="plot-label waterfall-label">
            {surfaceActive ? `3D history · ${surfaceDuration.toFixed(1)} / ${surfacePreferences.seconds} s · newest at front` : "Waterfall · newest at top"}
          </span>
          {surfaceActive && <div className="surface-axis" aria-hidden="true">
            <div className="surface-frequency">{labels.map(tick => <span key={tick.fraction} style={{ left: `${tick.fraction * 100}%`, transform: tick.fraction === 0 ? "none" : tick.fraction === 1 ? "translateX(-100%)" : "translateX(-50%)" }}>{tick.label}</span>)}</div>
            <span className="surface-age">0 s</span><span className="surface-oldest">Older · {surfacePreferences.seconds} s</span>
            <span className="surface-power"><span>Height · dB rel.</span><span>{floorDb} … {floorDb + rangeDb}</span></span>
          </div>}
          {surfaceCombined && session && hasFrame && <div className="surface-tuning" role="slider" tabIndex={0}
            aria-label="Front-row frequency tuning" aria-valuemin={session.hardwareCenterFrequencyHz - session.actualSampleRateHz / 2}
            aria-valuemax={session.hardwareCenterFrequencyHz + session.actualSampleRateHz / 2}
            aria-valuenow={session.selectedChannelFrequencyHz} aria-valuetext={formatFrequency(session.selectedChannelFrequencyHz)}
            title="Click to tune · Alt-click for free tuning · Arrow keys: 1 kHz · Shift: 10 kHz"
            onClick={tuneFromPosition} onKeyDown={event => {
              if (!["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End", "PageUp", "PageDown"].includes(event.key)) return;
              event.preventDefault();
              const center = session.hardwareCenterFrequencyHz, rate = session.actualSampleRateHz;
              const low = center - rate / 2, high = center + rate / 2;
              const direction = ["ArrowLeft", "ArrowDown", "PageDown"].includes(event.key) ? -1 : 1;
              const step = event.key.startsWith("Page") ? 100_000 : event.shiftKey ? 10_000 : 1_000;
              const hz = event.key === "Home" ? low : event.key === "End" ? high : session.selectedChannelFrequencyHz + direction * step;
              tuneFrequency(Math.max(low, Math.min(high, hz)), true);
            }}>
            <span className="surface-live-caption">Live spectrum · click frequency to tune</span>
            <span className="surface-live-selected">{formatFrequency(session.selectedChannelFrequencyHz)}</span>
            <span className="surface-tuning-marker" style={{ left: `${Math.max(0, Math.min(100, markerPositionPercent))}%` }} aria-hidden="true" />
            <span className="surface-tuning-ticks" aria-hidden="true">{labels.map(tick => <span key={tick.fraction} style={{ left: `${tick.fraction * 100}%`, transform: tick.fraction === 0 ? "none" : tick.fraction === 1 ? "translateX(-100%)" : "translateX(-50%)" }}>{tick.label}</span>)}</span>
          </div>}
          {paused ? (
            <span className="paused-label">
              Display paused · receiver still running
            </span>
          ) : null}
          {labels ? (
            <div className="frequency-rule" aria-hidden="true">
              {labels.map(tick => <span key={tick.fraction} style={{left: `${tick.fraction * 100}%`, transform: tick.fraction === 0 ? "none" : tick.fraction === 1 ? "translateX(-100%)" : "translateX(-50%)"}}>{tick.label}</span>)}
            </div>
          ) : null}
          {session ? (
            <span
              className="marker-label"
              style={{ left: `clamp(80px, ${markerPositionPercent}%, calc(100% - 80px))` }}
            >
              Channel {formatFrequency(session.selectedChannelFrequencyHz)}
            </span>
          ) : null}
          <div className="plot-metadata">
            <span className="display-units">Relative dB · not dBm</span>
            {surfaceActive && <small>Height & colour = relative level</small>}
            {session && (
              <small className="receiver-offset">
                Channel offset{" "}
                {session.selectedChannelFrequencyHz - session.hardwareCenterFrequencyHz >= 0 ? "+" : ""}
                {((session.selectedChannelFrequencyHz - session.hardwareCenterFrequencyHz) / 1_000).toFixed(3)}{" "}
                kHz
              </small>
            )}
          </div>
          {hoverEnabled && !surfaceCombined && visible && hasFrame && state.kind === "ready" && (
            <Suspense fallback={null}>
              <SpectrumHover key={`${renderer}:${session?.sessionGeneration}`}
                canvas={canvasRef} frame={hoverFrameRef} guideGap={guideGap}
                selectedHz={session?.selectedChannelFrequencyHz ?? 0}
                traceOnly={surfaceActive}
                traceFraction={surfaceActive ? SURFACE_TRACE_FRACTION : .38}
                paused={paused} stalled={stalled} />
            </Suspense>
          )}
          <SpectrumInfo>
            <p className="diagnostic-message">{state.message}</p>
            {fftMessage && <p className="display-note">{fftMessage}</p>}
            {renderer === "canvas2d" && <p className="display-note">Compatibility display · CPU/WASM analysis · peak-preserving 1024-column waterfall.</p>}
            <p className="display-note">
              {fftSize}-point Hann FFT ·{" "}
              {renderer === "webgpu" && requestedFftSize ? "4-frame power average" : "~40 ms power average"}{" "}
              · {surfaceActive ? `3D: bounded 512-row source-clock history, up to 25 peak-held intervals/s, 1024 peak-pooled columns; ${surfacePreferences.perspective ? "depth perspective; newest edge aligned" : "flat aligned frequency scale"}; gaps are left open; channel-only tuning keeps RF history with a separator (unknown tuning interruption is excluded from the source-time axis)` : "circular 240-row sample-clock history"} · relative dB (not dBm) ·
              click {surfaceActive ? "spectrum or grid" : "plot"} to retune · background tabs may resume with marked gaps
            </p>
            {surfaceState.startsWith("3D unavailable") && <p className="display-note">{surfaceState}</p>}
          </SpectrumInfo>
        </div>
      </div>

    </section>
  );
}

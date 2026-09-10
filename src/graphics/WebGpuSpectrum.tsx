import { useEffect, useMemo, useRef, useState, type MouseEvent } from "react";
import type { AnalysisPipeline } from "../dsp/analysisPipeline";
import { frequencyForPixel, spectrumEdges } from "../dsp/frequencyScale";
import { FFT_SIZE } from "../dsp/spectrumMath";
import type { SourceSessionMetadata, SpectrumFrame } from "../radio/types";
import { WaterfallHistory } from "./waterfallHistory";

type GpuState = { kind: "checking" | "ready" | "unsupported" | "error"; message: string };
const HISTORY_ROWS = 240;
const GPU_VERTEX_STAGE = 0x1;
const GPU_FRAGMENT_STAGE = 0x2;
const GPU_BUFFER_COPY_DST = 0x8;
const GPU_BUFFER_UNIFORM = 0x40;
const GPU_BUFFER_STORAGE = 0x80;
const GAP_LEVEL_DB = -10_000;

const shader = /* wgsl */ `
  @group(0) @binding(0) var<storage, read> levels: array<f32>;
  @group(0) @binding(1) var<storage, read> history: array<f32>;
  struct Display {
    markerX: f32, floorDb: f32, rangeDb: f32, _padding: f32,
    nextRow: u32, rowCount: u32, _padding2: vec2u,
  }
  @group(0) @binding(2) var<uniform> display: Display;
  struct FullscreenOutput { @builtin(position) position: vec4f, @location(0) uv: vec2f }
  @vertex fn fullscreenVertex(@builtin(vertex_index) index: u32) -> FullscreenOutput {
    let positions = array<vec2f, 3>(vec2f(-1.0, -1.0), vec2f(3.0, -1.0), vec2f(-1.0, 3.0));
    let p = positions[index];
    var output: FullscreenOutput;
    output.position = vec4f(p, 0.0, 1.0);
    output.uv = vec2f((p.x + 1.0) * 0.5, 1.0 - (p.y + 1.0) * 0.5);
    return output;
  }
  fn colorMap(value: f32) -> vec3f {
    let t = clamp(value, 0.0, 1.0);
    let cold = vec3f(0.012, 0.025, 0.09);
    let violet = vec3f(0.18, 0.08, 0.58);
    let electric = vec3f(0.08, 0.72, 0.98);
    let stellar = vec3f(0.95, 0.82, 1.0);
    return select(mix(cold, violet, t * 2.0), select(mix(violet, electric, (t - 0.5) * 3.0), mix(electric, stellar, (t - 0.83) * 5.88), t > 0.83), t > 0.5);
  }
  @fragment fn waterfallFragment(input: FullscreenOutput) -> @location(0) vec4f {
    if (input.uv.y < 0.38 || display.rowCount == 0u) { discard; }
    let relativeY = clamp((input.uv.y - 0.38) / 0.62, 0.0, 0.999999);
    let age = min(u32(relativeY * f32(display.rowCount)), display.rowCount - 1u);
    let row = (display.nextRow + ${HISTORY_ROWS}u - 1u - age) % ${HISTORY_ROWS}u;
    let bin = min(u32(clamp(input.uv.x, 0.0, 0.999999) * f32(${FFT_SIZE})), ${FFT_SIZE - 1}u);
    let level = history[row * ${FFT_SIZE}u + bin];
    if (level < -1000.0) { return vec4f(0.17, 0.19, 0.19, 1.0); }
    return vec4f(colorMap((level - display.floorDb) / display.rangeDb), 1.0);
  }
  @vertex fn spectrumVertex(@builtin(vertex_index) index: u32) -> @builtin(position) vec4f {
    let x = f32(index) / f32(${FFT_SIZE - 1}) * 2.0 - 1.0;
    let normalized = clamp((levels[index] - display.floorDb) / display.rangeDb, 0.0, 1.0);
    return vec4f(x, 0.25 + normalized * 0.67, 0.0, 1.0);
  }
  @vertex fn markerVertex(@builtin(vertex_index) index: u32) -> @builtin(position) vec4f {
    return vec4f(display.markerX, select(-0.92, 0.92, index == 1u), 0.0, 1.0);
  }
  @fragment fn spectrumFragment() -> @location(0) vec4f { return vec4f(0.29, 0.86, 1.0, 1.0); }
  @fragment fn markerFragment() -> @location(0) vec4f { return vec4f(0.94, 0.82, 1.0, 0.92); }
`;

function formatFrequency(frequencyHz: number): string {
  return `${(frequencyHz / 1_000_000).toFixed(3)} MHz`;
}

export function WebGpuSpectrum({ pipeline, session, onTune }: {
  pipeline: AnalysisPipeline;
  session?: SourceSessionMetadata;
  onTune?: (frequencyHz: number) => void;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const renderRef = useRef<() => void>(() => undefined);
  const pausedRef = useRef(false);
  const floorRef = useRef(-105);
  const rangeRef = useRef(90);
  const [paused, setPaused] = useState(false);
  const [floorDb, setFloorDb] = useState(-105);
  const [rangeDb, setRangeDb] = useState(90);
  const [gpuAttempt, setGpuAttempt] = useState(0);
  const [state, setState] = useState<GpuState>({ kind: "checking", message: "Requesting a GPU adapter and device…" });
  const labels = useMemo(() => session ? spectrumEdges(session.hardwareCenterFrequencyHz, session.actualSampleRateHz).map(formatFrequency) : undefined, [session]);
  const markerPositionPercent = session ? Math.max(0, Math.min(100, (0.5 + (session.selectedChannelFrequencyHz - session.hardwareCenterFrequencyHz) / session.actualSampleRateHz) * 100)) : 50;

  useEffect(() => {
    let disposed = false;
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
    const renderWhenVisible = () => { if (document.visibilityState === "visible") renderRef.current(); };
    const history = new WaterfallHistory(HISTORY_ROWS);
    history.reset(session?.sessionGeneration ?? 0);
    const gapRow = new Float32Array(FFT_SIZE).fill(GAP_LEVEL_DB);

    const writeDisplay = () => {
      if (!device || !displayBuffer) return;
      const data = new ArrayBuffer(32);
      const view = new DataView(data);
      const selected = session?.selectedChannelFrequencyHz ?? latestFrame?.centerFrequencyHz ?? 0;
      const center = latestFrame?.centerFrequencyHz ?? session?.hardwareCenterFrequencyHz ?? selected;
      const rate = latestFrame?.sampleRateHz ?? session?.actualSampleRateHz ?? 1;
      view.setFloat32(0, Math.max(-1, Math.min(1, 2 * (selected - center) / rate)), true);
      view.setFloat32(4, floorRef.current, true);
      view.setFloat32(8, rangeRef.current, true);
      view.setUint32(16, history.state.nextWriteRow, true);
      view.setUint32(20, history.state.count, true);
      device.queue.writeBuffer(displayBuffer, 0, data);
    };
    const render = () => {
      const canvas = canvasRef.current;
      if (!canvas || !device || !context || !waterfallPipeline || !spectrumPipeline || !markerPipeline || !bindGroup) return;
      const ratio = Math.max(1, window.devicePixelRatio || 1);
      const width = Math.min(Math.max(1, Math.round(canvas.clientWidth * ratio)), device.limits.maxTextureDimension2D);
      const height = Math.min(Math.max(1, Math.round(canvas.clientHeight * ratio)), device.limits.maxTextureDimension2D);
      if (canvas.width !== width) canvas.width = width;
      if (canvas.height !== height) canvas.height = height;
      writeDisplay();
      const encoder = device.createCommandEncoder({ label: "RF spectrum and waterfall commands" });
      const pass = encoder.beginRenderPass({ colorAttachments: [{ view: context.getCurrentTexture().createView(), clearValue: { r: 0.008, g: 0.02, b: 0.065, a: 1 }, loadOp: "clear", storeOp: "store" }] });
      pass.setBindGroup(0, bindGroup);
      pass.setPipeline(waterfallPipeline);
      pass.draw(3);
      if (latestFrame) {
        pass.setPipeline(spectrumPipeline);
        pass.draw(FFT_SIZE);
        pass.setPipeline(markerPipeline);
        pass.draw(2);
      }
      pass.end();
      device.queue.submit([encoder.finish()]);
    };
    renderRef.current = render;

    const unsubscribe = pipeline.subscribe((frame) => {
      if (gpuFailed || !device || !spectrumBuffer || !historyBuffer || frame.bins.length !== FFT_SIZE || pausedRef.current) return;
      latestFrame = frame;
      device.queue.writeBuffer(spectrumBuffer, 0, frame.bins);
      for (const row of history.append(frame)) {
        device.queue.writeBuffer(historyBuffer, row.row * FFT_SIZE * Float32Array.BYTES_PER_ELEMENT, row.bins ?? gapRow);
      }
      render();
      setState({ kind: "ready", message: frame.droppedFramesBefore > 0
        ? `WebGPU live · ${frame.droppedFramesBefore} display frame(s) skipped and marked in history`
        : `WebGPU live · ${(frame.sampleIndex / frame.sampleRateHz).toFixed(2)} s on source sample clock` });
    });

    async function initialize() {
      const canvas = canvasRef.current;
      if (!canvas || !("gpu" in navigator)) {
        setState({ kind: "unsupported", message: "WebGPU is unavailable. Use a current WebGPU-compatible desktop browser." });
        return;
      }
      try {
        const adapter = await navigator.gpu.requestAdapter();
        if (!adapter) {
          setState({ kind: "unsupported", message: "No compatible GPU adapter was found. Check browser GPU settings and graphics drivers." });
          return;
        }
        device = await adapter.requestDevice();
        if (disposed) { device.destroy(); return; }
        const requestedDevice = device;
        requestedDevice.lost.then((info) => {
          if (disposed || device !== requestedDevice) return;
          releaseGpuResources(false);
          setState({ kind: "error", message: `The GPU device was lost (${info.reason || "unknown"}). Select Retry graphics; if loss repeats, check browser GPU settings and drivers.` });
        });
        device.addEventListener("uncapturederror", onUncapturedError);
        context = canvas.getContext("webgpu") as GPUCanvasContext | null;
        if (!context) throw new Error("This browser could not create a WebGPU canvas context.");
        const format = navigator.gpu.getPreferredCanvasFormat();
        context.configure({ device, format, alphaMode: "opaque" });
        const module = device.createShaderModule({ code: shader, label: "RF spectrum and waterfall shader" });
        const compilation = await module.getCompilationInfo();
        const shaderErrors = compilation.messages.filter((message) => message.type === "error");
        if (shaderErrors.length) throw new Error(shaderErrors.map((message) => message.message).join("; "));
        const layout = device.createBindGroupLayout({ entries: [
          { binding: 0, visibility: GPU_VERTEX_STAGE, buffer: { type: "read-only-storage" } },
          { binding: 1, visibility: GPU_FRAGMENT_STAGE, buffer: { type: "read-only-storage" } },
          { binding: 2, visibility: GPU_VERTEX_STAGE | GPU_FRAGMENT_STAGE, buffer: { type: "uniform" } },
        ] });
        const pipelineLayout = device.createPipelineLayout({ bindGroupLayouts: [layout] });
        waterfallPipeline = device.createRenderPipeline({ label: "waterfall pipeline", layout: pipelineLayout, vertex: { module, entryPoint: "fullscreenVertex" }, fragment: { module, entryPoint: "waterfallFragment", targets: [{ format }] } });
        spectrumPipeline = device.createRenderPipeline({ label: "RF spectrum pipeline", layout: pipelineLayout, vertex: { module, entryPoint: "spectrumVertex" }, fragment: { module, entryPoint: "spectrumFragment", targets: [{ format }] }, primitive: { topology: "line-strip" } });
        markerPipeline = device.createRenderPipeline({ label: "selected frequency marker pipeline", layout: pipelineLayout, vertex: { module, entryPoint: "markerVertex" }, fragment: { module, entryPoint: "markerFragment", targets: [{ format }] }, primitive: { topology: "line-list" } });
        spectrumBuffer = device.createBuffer({ label: "spectrum levels", size: FFT_SIZE * 4, usage: GPU_BUFFER_STORAGE | GPU_BUFFER_COPY_DST });
        historyBuffer = device.createBuffer({ label: "circular waterfall power history", size: FFT_SIZE * HISTORY_ROWS * 4, usage: GPU_BUFFER_STORAGE | GPU_BUFFER_COPY_DST });
        displayBuffer = device.createBuffer({ label: "display controls", size: 32, usage: GPU_BUFFER_UNIFORM | GPU_BUFFER_COPY_DST });
        device.queue.writeBuffer(historyBuffer, 0, new Float32Array(FFT_SIZE * HISTORY_ROWS).fill(GAP_LEVEL_DB));
        bindGroup = device.createBindGroup({ layout, entries: [{ binding: 0, resource: { buffer: spectrumBuffer } }, { binding: 1, resource: { buffer: historyBuffer } }, { binding: 2, resource: { buffer: displayBuffer } }] });
        resizeObserver = new ResizeObserver(render);
        resizeObserver.observe(canvas);
        document.addEventListener("visibilitychange", renderWhenVisible);
        render();
        setState({ kind: "ready", message: "WebGPU ready · waiting for RF I/Q spectrum frames" });
      } catch (error) {
        if (!disposed) {
          releaseGpuResources(true);
          setState({ kind: "error", message: `WebGPU initialization failed: ${error instanceof Error ? error.message : String(error)}` });
        }
      }
    }
    void initialize();
    return () => {
      disposed = true;
      renderRef.current = () => undefined;
      unsubscribe();
      releaseGpuResources(true);
    };
    function onUncapturedError(event: GPUUncapturedErrorEvent): void {
      if (!disposed) {
        releaseGpuResources(true);
        setState({ kind: "error", message: `WebGPU rendering error: ${event.error.message}. Select Retry graphics to recreate GPU resources.` });
      }
    }
    function releaseGpuResources(destroyDevice: boolean): void {
      gpuFailed = true;
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
  }, [gpuAttempt, pipeline, session?.sessionGeneration]);

  const tuneFromClick = (event: MouseEvent<HTMLCanvasElement>) => {
    if (!session || !onTune) return;
    const bounds = event.currentTarget.getBoundingClientRect();
    const frequency = frequencyForPixel(event.clientX - bounds.left, bounds.width, session.hardwareCenterFrequencyHz, session.actualSampleRateHz);
    // Use exactly the keyboard-tuning path: source/backend validates the span.
    onTune(frequency);
  };
  const updatePaused = () => {
    pausedRef.current = !paused;
    setPaused(!paused);
    renderRef.current();
  };

  return (
    <section className="graphics-panel" aria-labelledby="graphics-heading">
      <div className="panel-heading"><div><p className="eyebrow">Graphics</p><h2 id="graphics-heading">RF spectrum + waterfall</h2></div><span className={`status-pill status-${state.kind}`}>{state.kind}</span></div>
      <div className="display-controls">
        <button type="button" className="secondary" onClick={updatePaused}>{paused ? "Resume display" : "Pause display"}</button>
        <label>Floor <output>{floorDb} dB</output><input type="range" min="-120" max="-30" step="1" value={floorDb} onChange={(event) => { const value = event.currentTarget.valueAsNumber; floorRef.current = value; setFloorDb(value); renderRef.current(); }} /></label>
        <label>Range <output>{rangeDb} dB</output><input type="range" min="20" max="120" step="1" value={rangeDb} onChange={(event) => { const value = event.currentTarget.valueAsNumber; rangeRef.current = value; setRangeDb(value); renderRef.current(); }} /></label>
      </div>
      <div className="canvas-frame">
        <canvas ref={canvasRef} width={960} height={560} aria-label="WebGPU RF spectrum and waterfall plot; click to tune" onClick={tuneFromClick} />
        <span className="plot-label spectrum-label">Spectrum</span><span className="plot-label waterfall-label">Waterfall · newest at top</span>
        {paused ? <span className="paused-label">Display paused · receiver still running</span> : null}
        {labels ? <div className="frequency-rule" aria-hidden="true"><span>{labels[0]}</span><span>{labels[1]}</span><span>{labels[2]}</span></div> : null}
        {session ? <span className="marker-label" style={{ left: `${markerPositionPercent}%` }}>Selected {formatFrequency(session.selectedChannelFrequencyHz)}</span> : null}
      </div>
      <p className="diagnostic-message" role="status">{state.message}</p>
      {state.kind === "error" ? <button type="button" className="secondary retry-graphics" onClick={() => { setState({ kind: "checking", message: "Recreating the GPU device and bounded display resources…" }); setGpuAttempt((attempt) => attempt + 1); }}>Retry graphics</button> : null}
      <p className="display-note">4096-point Hann FFT · 4-frame power average · circular 240-row sample-clock history · relative dB (not dBm) · click plot to retune · background tabs may resume with marked gaps</p>
    </section>
  );
}

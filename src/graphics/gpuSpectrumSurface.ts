import { surfaceProjection, pickSurfaceFrequency, type SurfacePickView } from "./spectrumSurfaceProjection";
import type { SpectrumFrame } from "../radio/types";
import type { SpectrumPalette } from "./spectrumPalette";
import { SpectrumSurfaceHistory, SURFACE_COLUMNS, SURFACE_ROWS } from "./spectrumSurfaceHistory";
import { spectrumSurfaceShader, SURFACE_MESH_COLUMNS } from "./spectrumSurfaceShader";

export interface SurfaceOptions {
  seconds: number;
  elevation: number;
  height: number;
  perspective: boolean;
  layout: "combined" | "separate";
}

/** Shares the existing display device and color target; owns only terrain resources. */
export class GpuSpectrumSurface {
  readonly history = new SpectrumSurfaceHistory();
  private readonly buffers: GPUBuffer[] = [];
  private readonly levels: GPUBuffer;
  private readonly rows: GPUBuffer;
  private readonly uniform: GPUBuffer;
  private readonly data = new ArrayBuffer(192);
  private readonly floats = new Float32Array(this.data);
  private readonly uints = new Uint32Array(this.data);
  private readonly group: GPUBindGroup;
  private depth?: GPUTexture;
  private cached?: GPUTexture;
  private cachedKey = "";
  private revision = 0;
  private pickView?: SurfacePickView;
  sceneDraws = 0;
  markerDraws = 0;
  private fullHeight = 1;
  private width = 0;
  private height = 0;

  private constructor(private readonly device: GPUDevice,
    private readonly surface: GPURenderPipeline, private readonly grid: GPURenderPipeline, private readonly live: GPURenderPipeline, private readonly markers: GPURenderPipeline, private readonly format: GPUTextureFormat,
    latest: GPUBuffer, private readonly fftSize: number) {
    const buffer = (label: string, size: number, usage: number) => {
      const result = device.createBuffer({ label, size, usage });
      this.buffers.push(result);
      return result;
    };
    try {
      this.levels = buffer("3D peak-held spectrum history", SURFACE_COLUMNS * SURFACE_ROWS * 4, 0x80 | 0x8);
      this.rows = buffer("3D source-clock row metadata", SURFACE_ROWS * 16, 0x80 | 0x8);
      this.uniform = buffer("3D camera and display scale", 192, 0x40 | 0x8);
      this.group = device.createBindGroup({ layout: surface.getBindGroupLayout(0), entries: [
        { binding: 0, resource: { buffer: this.levels } },
        { binding: 1, resource: { buffer: this.rows } },
        { binding: 2, resource: { buffer: this.uniform } },
        { binding: 3, resource: { buffer: latest } },
      ] });
    } catch (error) { this.dispose(); throw error; }
  }

  static async create(device: GPUDevice, format: GPUTextureFormat, latest: GPUBuffer, fftSize: number): Promise<GpuSpectrumSurface> {
    if (device.limits.maxStorageBufferBindingSize < SURFACE_COLUMNS * SURFACE_ROWS * 4 ||
      device.limits.maxBufferSize < SURFACE_COLUMNS * SURFACE_ROWS * 4 || device.limits.maxStorageBuffersPerShaderStage < 3)
      throw new Error("GPU limits cannot support 3D history.");
    device.pushErrorScope("out-of-memory");
    device.pushErrorScope("validation");
    let result: GpuSpectrumSurface | undefined;
    let failure: unknown;
    try {
      const module = device.createShaderModule({ label: "3D spectrum history WGSL", code: spectrumSurfaceShader });
      const compilation = await module.getCompilationInfo();
      const errors = compilation.messages.filter(message => message.type === "error");
      if (errors.length) throw new Error(errors.map(message => message.message).join("; "));
      const layout = device.createBindGroupLayout({ entries: [
        { binding: 0, visibility: 0x1, buffer: { type: "read-only-storage" } },
        { binding: 1, visibility: 0x1, buffer: { type: "read-only-storage" } },
        { binding: 2, visibility: 0x1 | 0x2, buffer: { type: "uniform" } },
        { binding: 3, visibility: 0x1, buffer: { type: "read-only-storage" } },
      ] });
      const pipelineLayout = device.createPipelineLayout({ bindGroupLayouts: [layout] });
      const make = (vertex: string, fragment: string, overlay = false, markers = false) => device.createRenderPipelineAsync({
        label: `3D ${vertex}`, layout: pipelineLayout,
        vertex: { module, entryPoint: vertex }, fragment: { module, entryPoint: fragment, targets: [{ format, ...(markers ? { blend: { color: { srcFactor: "src-alpha", dstFactor: "one-minus-src-alpha", operation: "add" }, alpha: { srcFactor: "one", dstFactor: "one-minus-src-alpha", operation: "add" } } } : {}) }] },
        primitive: { topology: "triangle-list" },
        depthStencil: { format: "depth24plus", depthWriteEnabled: !overlay && !markers, depthCompare: markers ? "less-equal" : overlay ? "always" : "less" },
      });
      const surface = await make("surfaceVertex", "surfaceFragment");
      const grid = await make("gridVertex", "gridFragment");
      const live = await make("liveVertex", "liveFragment", true);
      // Borrow the display FFT buffer; disposal leaves it with its original owner.
      const markers = await make("markerVertex", "markerFragment", false, true);
      result = new GpuSpectrumSurface(device, surface, grid, live, markers, format, latest, fftSize);
    } catch (error) { failure = error; }
    const validation = await device.popErrorScope();
    const allocation = await device.popErrorScope();
    if (failure || validation || allocation) {
      result?.dispose();
      throw failure ?? new Error(validation?.message ?? allocation?.message ?? "3D initialization failed.");
    }
    return result!;
  }

  accept(frames: readonly SpectrumFrame[]): void {
    for (const frame of frames) for (const row of this.history.accept(frame)) {
      this.revision++;
      this.device.queue.writeBuffer(this.levels, row * SURFACE_COLUMNS * 4,
        this.history.levels.subarray(row * SURFACE_COLUMNS, (row + 1) * SURFACE_COLUMNS));
      this.device.queue.writeBuffer(this.rows, row * 16, this.history.metadata.subarray(row * 4, row * 4 + 4));
    }
  }

  reset(): void { this.history.reset(); this.revision++; this.pickView = undefined; }

  pick(x: number, y: number, cssWidth: number, cssHeight: number, bins?: Float32Array): number | undefined {
    const view = this.pickView;
    if (!view) return;
    return pickSurfaceFrequency(x,y,{...view,width:cssWidth,height:view.height/this.fullHeight*cssHeight,
      top:view.top/this.fullHeight*cssHeight},this.history,bins);
  }

  encode(encoder: GPUCommandEncoder, texture: GPUTexture, width: number, height: number,
    top: number, footerPixels: number, floor: number, range: number, options: SurfaceOptions, palette: SpectrumPalette,
    selected: number, bands: readonly number[], pixelRatio: number): void {
    const combined = options.layout === "combined";
    if (width !== this.width || height !== this.height || !this.depth) {
      this.depth?.destroy(); this.cached?.destroy(); this.cached = undefined; this.cachedKey = "";
      this.depth = this.device.createTexture({label:"3D bounded depth",size:[width,height],format:"depth24plus",usage:0x10});
      this.width=width; this.height=height;
    }
    if(combined && !this.cached) this.cached=this.device.createTexture({label:"3D retained terrain color",size:[width,height],format:this.format,usage:0x10|0x1});
    const y=Math.max(0,Math.min(height-1,top));
    const footer=Math.min((height-y)*.3,footerPixels), plotHeight=Math.max(1,height-y-footer);
    this.fullHeight=height;
    this.pickView={width,height:plotHeight,top:y,floor,range,seconds:options.seconds,projection:surfaceProjection(options),combined};
    this.floats.set([floor,range,options.seconds,this.history.latestTime]);
    this.uints[4]=this.history.nextRow; this.uints[5]=this.history.count;
    this.floats[6]=options.elevation; this.floats[7]=options.height;
    this.floats[8]=selected; this.floats[9]=options.perspective?1:0;
    this.uints[10]=this.fftSize; this.floats[11]=combined?1:0;
    this.floats.set(bands,12); this.floats.set(palette.uniforms,16);
    this.floats.set([width,plotHeight,pixelRatio,0],40);
    this.floats.set(this.pickView.projection,44);
    this.device.queue.writeBuffer(this.uniform,0,this.data);
    const key=JSON.stringify([width,height,y,footer,floor,range,options,palette.uniforms,this.revision]);
    const visibleRows=this.history.visibleRows(options.seconds);
    const configure=(pass:GPURenderPassEncoder) => {
      pass.setViewport(0,y,width,plotHeight,0,1);
      pass.setScissorRect(0,Math.ceil(y),width,Math.max(1,Math.floor(plotHeight)));
      pass.setBindGroup(0,this.group);
    };
    if(!combined || key!==this.cachedKey) {
      const pass=encoder.beginRenderPass({label:"3D spectrum history",
        colorAttachments:[{view:(combined?this.cached!:texture).createView(),loadOp:combined?"clear":"load",storeOp:"store",
          clearValue:{r:palette.background[0],g:palette.background[1],b:palette.background[2],a:1}}],
        depthStencilAttachment:{view:this.depth.createView(),depthClearValue:1,depthLoadOp:"clear",depthStoreOp:"store"}});
      configure(pass);
      pass.setPipeline(this.grid); pass.draw(6);
      if(visibleRows>1) { pass.setPipeline(this.surface); pass.draw((visibleRows-1)*(SURFACE_MESH_COLUMNS-1)*6); }
      if(combined && this.history.count>0) { pass.setPipeline(this.live); pass.draw((this.fftSize-1)*6); }
      pass.end(); this.sceneDraws++;
      this.cachedKey=combined?key:"";
    }
    if(combined) encoder.copyTextureToTexture({texture:this.cached!},{texture},[width,height]);
    const markers=encoder.beginRenderPass({label:"3D channel markers",
      colorAttachments:[{view:texture.createView(),loadOp:"load",storeOp:"store"}],
      depthStencilAttachment:{view:this.depth.createView(),depthLoadOp:"load",depthStoreOp:"store"}});
    configure(markers); markers.setPipeline(this.markers);
    markers.draw(6,5,0,5);
    if(visibleRows>1) markers.draw((visibleRows-1)*2*6,5);
    markers.end(); this.markerDraws++;
  }

  dispose(): void {
    this.depth?.destroy(); this.depth = undefined;
    this.cached?.destroy(); this.cached = undefined; this.pickView = undefined;
    for (const buffer of this.buffers.splice(0)) buffer.destroy();
  }
}

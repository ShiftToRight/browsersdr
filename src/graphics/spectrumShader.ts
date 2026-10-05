export const HISTORY_ROWS = 240;

export const spectrumShader = (size: number) => /* wgsl */ `
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
    let bin = min(u32(clamp(input.uv.x, 0.0, 0.999999) * f32(${size})), ${size - 1}u);
    let level = history[row * ${size}u + bin];
    if (level < -1000.0) { return vec4f(0.17, 0.19, 0.19, 1.0); }
    return vec4f(colorMap((level - display.floorDb) / display.rangeDb), 1.0);
  }
  @vertex fn spectrumVertex(@builtin(vertex_index) index: u32) -> @builtin(position) vec4f {
    let x = f32(index) / f32(${size - 1}) * 2.0 - 1.0;
    let normalized = clamp((levels[index] - display.floorDb) / display.rangeDb, 0.0, 1.0);
    return vec4f(x, 0.25 + normalized * 0.67, 0.0, 1.0);
  }
  @vertex fn markerVertex(@builtin(vertex_index) index: u32) -> @builtin(position) vec4f {
    return vec4f(display.markerX, select(-0.92, 0.92, index == 1u), 0.0, 1.0);
  }
  @fragment fn spectrumFragment() -> @location(0) vec4f { return vec4f(0.29, 0.86, 1.0, 1.0); }
  @fragment fn markerFragment() -> @location(0) vec4f { return vec4f(0.34, 0.86, 1.0, 0.96); }
`;

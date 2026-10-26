import { SURFACE_COLUMNS, SURFACE_ROWS } from "./spectrumSurfaceHistory";

// Use every retained frequency column, without a second pooling/stride stage.
export const SURFACE_MESH_COLUMNS = SURFACE_COLUMNS;
export const spectrumSurfaceShader = /* wgsl */ `
@group(0) @binding(0) var<storage, read> levels: array<f32>;
@group(0) @binding(1) var<storage, read> rows: array<vec4f>;
struct Display {
  floor: f32, range: f32, seconds: f32, latest: f32,
  nextRow: u32, count: u32, elevation: f32, height: f32,
  selected: f32, perspective: f32, fftSize: u32, combined: f32,
  bands: vec4f,
  cold: vec4f, mid: vec4f, hot: vec4f, peak: vec4f, trace: vec4f, marker: vec4f,
  viewport: vec4f, projection: vec4f,
}
@group(0) @binding(2) var<uniform> d: Display;
@group(0) @binding(3) var<storage, read> latestSpectrum: array<f32>;
struct Output { @builtin(position) position: vec4f, @location(0) coordinate: vec3f }
fn project(x: f32, age: f32, value: f32) -> vec4f {
  let w = 1.0 + age * d.projection.z;
  return vec4f((x - 0.5) * 2.0, d.projection.x + age * d.projection.y + value * d.projection.w,
    0.1 + age * 0.8 - value * 0.015,w);
}
fn colorMap(value: f32) -> vec3f {
  let t = clamp(value, 0.0, 1.0);
  if (t <= 0.5) { return mix(d.cold.rgb, d.mid.rgb, t * 2.0); }
  if (t <= 0.83) { return mix(d.mid.rgb, d.hot.rgb, (t - 0.5) / 0.33); }
  return mix(d.hot.rgb, d.peak.rgb, (t - 0.83) / 0.17);
}
@vertex fn surfaceVertex(@builtin(vertex_index) index: u32) -> Output {
  let cell = index / 6u;
  let xCell = cell % ${SURFACE_MESH_COLUMNS - 1}u;
  let r = cell / ${SURFACE_MESH_COLUMNS - 1}u;
  let corner = array<vec2u, 6>(vec2u(0,0),vec2u(1,0),vec2u(0,1),vec2u(0,1),vec2u(1,0),vec2u(1,1))[index % 6u];
  let row0 = (d.nextRow + ${SURFACE_ROWS}u - 1u - r) % ${SURFACE_ROWS}u;
  let row1 = (row0 + ${SURFACE_ROWS - 1}u) % ${SURFACE_ROWS}u;
  let age0 = (d.latest - rows[row0].x) / d.seconds;
  let age1 = (d.latest - rows[row1].x) / d.seconds;
  let col0 = xCell;
  let col1 = xCell + 1u;
  var o: Output;
  o.position = vec4f(2.0,2.0,2.0,1.0);
  o.coordinate = vec3f(0.0);
  // Whole cell rejection prevents bridges across clock gaps and invalid bins.
  let a = levels[row0 * ${SURFACE_COLUMNS}u + col0];
  let b = levels[row0 * ${SURFACE_COLUMNS}u + col1];
  let c = levels[row1 * ${SURFACE_COLUMNS}u + col0];
  let e = levels[row1 * ${SURFACE_COLUMNS}u + col1];
  if (r + 1u >= d.count || rows[row0].y == 0.0 || rows[row1].y == 0.0 || age1 > 1.0 ||
      min(min(a,b),min(c,e)) < -1000.0) { return o; }
  let value = select(select(a,b,corner.x == 1u),select(c,e,corner.x == 1u),corner.y == 1u);
  let normalized = clamp((value - d.floor) / d.range, 0.0, 1.0);
  let age = select(age0, age1, corner.y == 1u);
  let x = f32(xCell + corner.x) / ${SURFACE_MESH_COLUMNS - 1}.0;
  o.position = project(x,age,normalized);
  o.coordinate = vec3f(x,age,normalized);
  return o;
}
@fragment fn surfaceFragment(o: Output) -> @location(0) vec4f {
  let color = colorMap(o.coordinate.z);
  return vec4f(color, 1.0);
}
// Two-pixel ribbon uses the true latest display FFT, not the peak-held history.
@vertex fn liveVertex(@builtin(vertex_index) index: u32) -> Output {
  let segment = index / 6u;
  let corner = array<vec2f,6>(vec2f(0,-1),vec2f(0,1),vec2f(1,-1),vec2f(1,-1),vec2f(0,1),vec2f(1,1))[index % 6u];
  let a = latestSpectrum[segment];
  let b = latestSpectrum[segment + 1u];
  var o: Output;
  o.position = vec4f(2,2,2,1); o.coordinate = vec3f(0);
  if (!(a >= -1000.0 && a <= 1000.0 && b >= -1000.0 && b <= 1000.0)) { return o; }
  let p = project(f32(segment) / f32(d.fftSize - 1u),0,clamp((a-d.floor)/d.range,0,1));
  let q = project(f32(segment+1u) / f32(d.fftSize - 1u),0,clamp((b-d.floor)/d.range,0,1));
  let delta = (q.xy/q.w - p.xy/p.w) * d.viewport.xy;
  let normal = vec2f(-delta.y,delta.x) / max(length(delta),0.001);
  o.position = mix(p,q,corner.x);
  o.position = vec4f(o.position.xy + normal * corner.y * 2.0 / d.viewport.xy * o.position.w,o.position.zw);
  return o;
}
@fragment fn liveFragment() -> @location(0) vec4f { return vec4f(d.peak.rgb,1); }

// Screen-space ribbons: constant CSS width and analytic antialiasing. Each
// history cell is split at its mesh diagonal, so markers follow its triangles.
fn level(value: f32) -> f32 { return clamp((value-d.floor)/d.range,0.0,1.0); }
@vertex fn markerVertex(@builtin(vertex_index) index: u32, @builtin(instance_index) instance: u32) -> Output {
  let line = instance % 5u;
  let x = array<f32,5>(d.selected,d.bands.x,d.bands.y,d.bands.z,d.bands.w)[line];
  var o: Output; o.position=vec4f(2,2,2,1); o.coordinate=vec3f(0);
  if(x<0.0 || x>1.0) { return o; }
  var p=project(x,0,0); var q=project(x,1,0);
  if(instance<5u) {
    let segment=index/6u; let r=segment/2u;
    if(r+1u>=d.count) { return o; }
    let row0=(d.nextRow+${SURFACE_ROWS}u-1u-r)%${SURFACE_ROWS}u;
    let row1=(row0+${SURFACE_ROWS-1}u)%${SURFACE_ROWS}u;
    let age0=(d.latest-rows[row0].x)/d.seconds; let age1=(d.latest-rows[row1].x)/d.seconds;
    if(rows[row0].y==0.0 || rows[row1].y==0.0 || age1>1.0) { return o; }
    let col=min(u32(x*${SURFACE_MESH_COLUMNS-1}.0),${SURFACE_MESH_COLUMNS-2}u);
    let f=x*${SURFACE_MESH_COLUMNS-1}.0-f32(col);
    let a=levels[row0*${SURFACE_COLUMNS}u+col]; let b=levels[row0*${SURFACE_COLUMNS}u+col+1u];
    let c=levels[row1*${SURFACE_COLUMNS}u+col]; let e=levels[row1*${SURFACE_COLUMNS}u+col+1u];
    if(min(min(a,b),min(c,e)) < -1000.0) { return o; }
    let front=project(x,age0,mix(level(a),level(b),f));
    let back=project(x,age1,mix(level(c),level(e),f));
    let diagonal=project(x,mix(age0,age1,1.0-f),mix(level(c),level(b),f));
    p=select(front,diagonal,segment%2u==1u); q=select(diagonal,back,segment%2u==1u);
  }
  let corner=array<vec2f,6>(vec2f(0,-1),vec2f(0,1),vec2f(1,-1),vec2f(1,-1),vec2f(0,1),vec2f(1,1))[index%6u];
  let delta=(q.xy/q.w-p.xy/p.w)*d.viewport.xy;
  let normal=vec2f(-delta.y,delta.x)/max(length(delta),0.001);
  let core=select(0.45,0.65,line==0u)*d.viewport.z;
  let radius=core+1.0;
  o.position=mix(p,q,corner.x);
  o.position=vec4f(o.position.xy+normal*corner.y*radius*2.0/d.viewport.xy*o.position.w,o.position.z-0.0001*o.position.w,o.position.w);
  o.coordinate=vec3f(corner.y*radius,core,select(0.72,1.0,line==0u));
  return o;
}
@fragment fn markerFragment(o: Output) -> @location(0) vec4f {
  let alpha=(1.0-smoothstep(max(0.0,o.coordinate.y-0.5),o.coordinate.y+0.5,abs(o.coordinate.x)))*o.coordinate.z;
  return vec4f(d.marker.rgb,alpha);
}
@vertex fn gridVertex(@builtin(vertex_index) index: u32) -> Output {
  let xy = array<vec2f,6>(vec2f(0,0),vec2f(1,0),vec2f(0,1),vec2f(0,1),vec2f(1,0),vec2f(1,1))[index];
  var o: Output;
  o.position = project(xy.x,xy.y,0.0);
  o.position.z += 0.002;
  o.coordinate = vec3f(xy,0.0);
  return o;
}
@fragment fn gridFragment(o: Output) -> @location(0) vec4f {
  let xy = o.coordinate.xy * vec2f(10.0,8.0);
  let distance = abs(fract(xy - 0.5) - 0.5) / max(fwidth(xy),vec2f(0.001));
  let line = 1.0 - clamp(min(distance.x,distance.y),0.0,1.0);
  let center = abs(o.coordinate.x - 0.5) < max(fwidth(o.coordinate.x),0.001);
  let grid = mix(d.cold.rgb,d.trace.rgb,select(line * 0.18,0.35,center));
  return vec4f(grid,1.0);
}
`;

import type { SpectrumSurfaceSettings } from "./spectrumSurfaceSettings";
import { SURFACE_COLUMNS, SURFACE_ROWS, type SpectrumSurfaceHistory } from "./spectrumSurfaceHistory";

type Camera = Pick<SpectrumSurfaceSettings, "elevation" | "height" | "perspective" | "layout">;
export type Projection = readonly [number, number, number, number];
/** Shared camera coefficients: uploaded to WGSL and used for click picking. */
export function surfaceProjection(o: Camera): Projection {
  const tilt = (o.elevation - 22) / 38;
  if (o.perspective) {
    const depth = o.layout === "combined" ? Math.min(.50 + tilt * .17, .81 - .154 * o.height) : .30 + tilt * .17;
    return [-.68, 2 * depth * 1.428571 - .68 * .428571, .428571, .44 * o.height];
  }
  const depth = o.layout === "combined" ? Math.min(1.10 + tilt * .16, 1.66 - .44 * o.height) : .72 + tilt * .27;
  return [-.72, depth, 0, .44 * o.height];
}
export function projectSurface(x: number, age: number, value: number, p: Projection) {
  const w = 1 + age * p[2];
  return { x: (2 * x - 1) / w, y: (p[0] + age * p[1] + value * p[3]) / w,
    z: (.1 + age * .8 - value * .015) / w, w };
}
export interface SurfacePickView {
  width: number; height: number; top: number; floor: number; range: number;
  seconds: number; projection: Projection; combined: boolean;
}
/** Frequency picking only. No signal identity or historical-level measurement. */
export function pickSurfaceFrequency(px: number, py: number, view: SurfacePickView,
  history: SpectrumSurfaceHistory, latest?: Float32Array): number | undefined {
  const {width, height, top, projection:p} = view;
  if (width <= 0 || height <= 0) return;
  const nx = px / width * 2 - 1, ny = 1 - (py - top) / height * 2;
  const norm = (v: number) => Math.max(0, Math.min(1, (v - view.floor) / view.range));
  if (view.combined && latest) {
    let best = 9 * 9, fraction: number | undefined;
    for (let i = 0; i < latest.length - 1; i++) {
      const a = latest[i]!, b = latest[i + 1]!;
      if (!Number.isFinite(a) || !Number.isFinite(b) || Math.min(a,b) < -1000) continue;
      const va = projectSurface(i / (latest.length - 1),0,norm(a),p);
      const vb = projectSurface((i+1) / (latest.length - 1),0,norm(b),p);
      const ax=(va.x+1)*width/2, ay=top+(1-va.y)*height/2;
      const dx=(vb.x-va.x)*width/2, dy=(va.y-vb.y)*height/2;
      const t=Math.max(0,Math.min(1,((px-ax)*dx+(py-ay)*dy)/(dx*dx+dy*dy || 1)));
      const distance=(px-ax-t*dx)**2+(py-ay-t*dy)**2;
      if(distance<best) {best=distance;fraction=(i+t)/(latest.length-1);}
    }
    if(fraction !== undefined) return fraction;
  }
  if(ny < -1 || ny > 1 || nx < -1 || nx > 1) return;
  let nearest = Infinity, picked: number | undefined;
  const vertex = (col:number, row:number, age:number) => {
    const x=col/(SURFACE_COLUMNS-1), value=norm(history.levels[row*SURFACE_COLUMNS+col]!);
    return {...projectSurface(x,age,value,p), frequency:x};
  };
  const triangle = (a:ReturnType<typeof vertex>,b:ReturnType<typeof vertex>,c:ReturnType<typeof vertex>) => {
    const area=(b.y-c.y)*(a.x-c.x)+(c.x-b.x)*(a.y-c.y);
    if(Math.abs(area)<1e-14) return;
    const u=((b.y-c.y)*(nx-c.x)+(c.x-b.x)*(ny-c.y))/area;
    const v=((c.y-a.y)*(nx-c.x)+(a.x-c.x)*(ny-c.y))/area, w=1-u-v;
    if(Math.min(u,v,w)<-1e-7) return;
    const depth=u*a.z+v*b.z+w*c.z;
    if(depth<nearest) { nearest=depth; picked=(u*a.frequency/a.w+v*b.frequency/b.w+w*c.frequency/c.w)/(u/a.w+v/b.w+w/c.w); }
  };
  const count=history.visibleRows(view.seconds);
  for(let i=0;i<count-1;i++) {
    const r0=(history.nextRow+SURFACE_ROWS-1-i)%SURFACE_ROWS, r1=(r0+SURFACE_ROWS-1)%SURFACE_ROWS;
    if(!history.metadata[r0*4+1] || !history.metadata[r1*4+1]) continue;
    const a0=(history.latestTime-history.metadata[r0*4]!)/view.seconds, a1=(history.latestTime-history.metadata[r1*4]!)/view.seconds;
    // A click ray crosses only these frequency cells in each temporal interval.
    const c0=(.5+.5*nx*(1+p[2]*a0))*(SURFACE_COLUMNS-1), c1=(.5+.5*nx*(1+p[2]*a1))*(SURFACE_COLUMNS-1);
    for(let col=Math.max(0,Math.floor(Math.min(c0,c1)));col<=Math.min(SURFACE_COLUMNS-2,Math.floor(Math.max(c0,c1)));col++) {
      if(Math.min(history.levels[r0*SURFACE_COLUMNS+col]!,history.levels[r0*SURFACE_COLUMNS+col+1]!,history.levels[r1*SURFACE_COLUMNS+col]!,history.levels[r1*SURFACE_COLUMNS+col+1]!) < -1000) continue;
      const a=vertex(col,r0,a0),b=vertex(col+1,r0,a0),c=vertex(col,r1,a1),d=vertex(col+1,r1,a1);
      triangle(a,b,c); triangle(c,b,d);
    }
  }
  if(picked !== undefined) return picked;
  const age=(ny-p[0])/(p[1]-ny*p[2]);
  const x=.5+.5*nx*(1+p[2]*age);
  return age>=-1e-7 && age<=1+1e-7 && x>=-1e-7 && x<=1+1e-7 ? Math.max(0,Math.min(1,x)) : undefined;
}

import {describe,it,expect} from "vitest";
import {surfaceSettings} from "./spectrumSurfaceSettings";
import {surfaceProjection,projectSurface,pickSurfaceFrequency,type SurfacePickView} from "./spectrumSurfaceProjection";
import {SpectrumSurfaceHistory,SURFACE_COLUMNS} from "./spectrumSurfaceHistory";
import type {SpectrumFrame} from "../radio/types";
const options=surfaceSettings({view:"3d"});
const view:SurfacePickView={width:2000,height:800,top:20,floor:-100,range:100,seconds:10,projection:surfaceProjection(options),combined:true};
const point=(x:number,age:number,value:number,v=view)=>{const p=projectSurface(x,age,value,v.projection);return [(p.x+1)*v.width/2,v.top+(1-p.y)*v.height/2] as const;};
const frame=(sequence:number,sampleIndex:number,value=-70):SpectrumFrame=>({sequence,sampleIndex,timestampMs:0,bins:new Float32Array(SURFACE_COLUMNS).fill(value),centerFrequencyHz:100e6,sampleRateHz:1000,sessionGeneration:1,units:"relative-dB",droppedFramesBefore:0,hopSamples:40});
describe("3D frequency picking",()=>{
 it("keeps the newest edge full width and decodes receding empty grid coordinates",()=>{
  const history=new SpectrumSurfaceHistory();
  for(const perspective of [true,false]) for(const elevation of [22,38,60]) {
   const v={...view,projection:surfaceProjection({...options,perspective,elevation})};
   for(const age of [0,.2,.8,1]) for(const x of [.12,.3,.7,.89]) {
    const [px,py]=point(x,age,0,v);
    expect(pickSurfaceFrequency(px,py,v,history)).toBeCloseTo(x,6);
   }
  }
  expect(projectSurface(0,0,1,view.projection).x).toBe(-1);
  expect(projectSurface(1,0,0,view.projection).x).toBe(1);
  expect(pickSurfaceFrequency(0,0,view,history)).toBeUndefined();
 });
 it("picks the visible terrain, including its sloping triangle, rather than the floor beneath",()=>{
  const history=new SpectrumSurfaceHistory(); history.accept(frame(0,0)); history.accept(frame(1,40,-30));
  // Constant height across frequency; interpolation in depth is an actual planar mesh.
  const [px,py]=point(.73,.002,.5);
  expect(pickSurfaceFrequency(px,py,view,history)).toBeCloseTo(.73,5);
 });
 it("picks the moving full-resolution front trace above the floor with a small screen-space tolerance",()=>{
  const history=new SpectrumSurfaceHistory(),bins=new Float32Array(4096).fill(-100);
  bins[2866]=-10;
  const fraction=2866/4095,[px,py]=point(fraction,0,.9);
  expect(pickSurfaceFrequency(px,py,view,history,bins)).toBeCloseTo(fraction,4);
  const floor=pickSurfaceFrequency(px,py,view,history);
  expect(floor === undefined || Math.abs(floor-fraction)>1e-4).toBe(true);
 });
 it("never bridges missing terrain rows, and bounds exaggerated rear peaks",()=>{
  const history=new SpectrumSurfaceHistory(); history.accept(frame(0,0)); history.breakContinuity(); history.accept(frame(1,40));
  const [px,py]=point(.7,.002,.3);
  const hit=pickSurfaceFrequency(px,py,view,history);
  expect(hit === undefined || Math.abs(hit-.7)>1e-5).toBe(true);
  for(const perspective of [false,true]) for(const height of [.5,1.6]) for(const elevation of [22,60]) {
   const p=surfaceProjection({...options,perspective,height,elevation});
   expect(projectSurface(.5,1,1,p).y).toBeLessThanOrEqual(.941);
  }
 });
});

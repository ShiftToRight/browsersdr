import {it,expect} from "vitest";
import {channelOnlyDisplayChange,SurfaceMarkerMotion} from "./spectrumDisplaySession";
import type {SourceSessionMetadata} from "../radio/types";
const session:SourceSessionMetadata={source:"synthetic",sessionGeneration:1,requestedSampleRateHz:1024000,actualSampleRateHz:1024000,hardwareCenterFrequencyHz:100e6,selectedChannelFrequencyHz:100e6,mode:"WBFM",channelBandwidthHz:150000,squelch:0,gainDb:null,sampleFormat:"planar-f32-iq-normalized"};
it("preserves only a compatible channel-only change, never a new source, rate, gain, mode or window",()=>{
 const next={...session,sessionGeneration:2,selectedChannelFrequencyHz:100.2e6};
 expect(channelOnlyDisplayChange(session,next)).toBe(true);
 for(const patch of [{hardwareCenterFrequencyHz:100.2e6},{actualSampleRateHz:2048000},{gainDb:10},{mode:"AM" as const},{source:"replay" as const},{sessionGeneration:0}]) expect(channelOnlyDisplayChange(session,{...next,...patch})).toBe(false);
 expect(channelOnlyDisplayChange(undefined,next)).toBe(false);
});
it("moves smoothly, can reverse midway without a jump, and respects reduced motion",()=>{
 const motion=new SurfaceMarkerMotion();motion.set([.2,.3],0,false);expect(motion.sample(0)).toEqual([.2,.3]);
 motion.set([.8,.9],10,true);expect(motion.sample(10)).toEqual([.2,.3]);expect(motion.sample(90)[0]).toBeCloseTo(.5);
 motion.set([.1,.2],90,true);expect(motion.sample(90)[0]).toBeCloseTo(.5);expect(motion.sample(250)).toEqual([.1,.2]);expect(motion.moving(250)).toBe(false);
 motion.set([.8,.9],260,false);expect(motion.sample(260)).toEqual([.8,.9]);expect(motion.moving(260)).toBe(false);
});

it("presents intermediate positions even when one GPU frame is slower than the nominal animation",()=>{
 const m=new SurfaceMarkerMotion();m.set([.2],0,false);m.set([.8],0,true);
 expect(m.advance(300)[0]).toBeGreaterThan(.2);expect(m.sample(300)[0]).toBeLessThan(.8);
 expect(m.moving(300)).toBe(true);
 m.advance(600);m.advance(900);expect(m.advance(1200)[0]).toBe(.8);expect(m.moving(1200)).toBe(false);expect(m.advance(2400)).toEqual([.8]);expect(m.moving(2400)).toBe(false);
});

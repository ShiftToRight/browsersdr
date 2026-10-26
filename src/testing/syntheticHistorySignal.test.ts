import { expect, it } from "vitest";
import { SyntheticHistorySignal } from "./syntheticHistorySignal";
it("generates deterministic complex bursts with phase-continuous block boundaries and silent gaps", () => {
  const rate=10000,total=rate*3;
  const a=new SyntheticHistorySignal(),b=new SyntheticHistorySignal();
  const I=new Float32Array(total),Q=new Float32Array(total);a.mix(I,Q,rate);
  const firstI=new Float32Array(10001),firstQ=new Float32Array(10001);
  const lastI=new Float32Array(total-10001),lastQ=new Float32Array(total-10001);
  b.mix(firstI,firstQ,rate);b.mix(lastI,lastQ,rate);
  expect([...firstI,...lastI]).toEqual([...I]);expect([...firstQ,...lastQ]).toEqual([...Q]);
  expect(I.subarray(rate,rate*2).every(v=>v===0)).toBe(true);
  expect(I.subarray(100,rate*.5).some(v=>Math.abs(v)>.1)).toBe(true);
  expect(I.subarray(rate*2.5).some(v=>Math.abs(v)>.1)).toBe(true);
});

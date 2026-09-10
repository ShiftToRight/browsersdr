import { expect, it } from 'vitest';
import { Demodulator } from '@jtarrio/signals/demod/demodulator.js';
import type { Player } from '@jtarrio/signals/demod/player.js';
import type { RtlDevice } from '@jtarrio/webrtlsdr/rtlsdr/rtldevice.js';
import { SpectrumAccumulator } from '../dsp/spectrumMath';
import { SyntheticComplexTone } from '../testing/syntheticTone';
import { ReceiverController, type ReceiverBackendEvents } from '../radio/receiverController';
import { createDeterministicRecordingFixture } from '../testing/recordingFixture';
import { parseRecording } from '../radio/iqRecording';
import { planChannelTune } from '../radio/receiverConfig';
import { RdsDecoder } from '../rds/rdsDecoder';
import { createRdsMultiplexFixture } from '../testing/rdsFixture';
import { RdsMultiplexReceiver, AudioFirstRdsReceiver } from '../rds/rdsMultiplexReceiver';
import { AcknowledgedRtlSource } from './acknowledgedRtlSource';
import type { RdsState } from '../rds/rdsDecoder';

it('the gain adapter must return the acknowledged value used by Radio metadata',async()=>{
  // Real RTL2832U.setGain is Promise<void>; RtlSource forwards it unchanged.
  let gain: number | null = null;
  const source=new AcknowledgedRtlSource({setGain:async(value:number|null)=>{gain=value;}, getGain:()=>gain} as unknown as RtlDevice);
  expect(await source.setParameter('gain',25)).toBe(25);
});

function resampleFixture(rate:number){
  const input=createRdsMultiplexFixture();
  return Float32Array.from({length:Math.floor(input.length*rate/228000)},(_,n)=>{
    const pos=n*228000/rate,index=Math.floor(pos),fraction=pos-index;
    return input[index]!*(1-fraction)+(input[index+1]??input[index]!)*fraction;
  });
}

it('RDS decodes the fixture at the actual 336 kHz multiplex rate',()=>{
  const decoder=new RdsDecoder();decoder.configure(336000);decoder.process(resampleFixture(336000));
  expect(decoder.getState()).toMatchObject({pi:'C201',programmeService:'CODEX FM',radioText:'BrowserSDR RDS fixture'});
});

it('RDS decodes through the real FM stage at 1.024 MS/s',()=>{
  let state: RdsState | undefined;
  const receiver=new RdsMultiplexReceiver(value=>{state=value;});receiver.setSampleRate(1024000);
  const multiplex=resampleFixture(1024000);let phase=0;
  for(let offset=0;offset<multiplex.length;offset+=51200){
    const length=Math.min(51200,multiplex.length-offset),I=new Float32Array(length),Q=new Float32Array(length);
    for(let n=0;n<length;n++){phase+=2*Math.PI*75000*multiplex[offset+n]!/1024000;I[n]=Math.cos(phase)*0.7;Q[n]=Math.sin(phase)*0.7;}
    receiver.receiveSamples({I,Q,frequency:100000000});
  }
  expect(state).toMatchObject({pi:'C201',programmeService:'CODEX FM',radioText:'BrowserSDR RDS fixture'});
},10000);

const metadata = {source:'rtl-sdr' as const,requestedSampleRateHz:1024000,actualSampleRateHz:1024000,hardwareCenterFrequencyHz:100000000,selectedChannelFrequencyHz:100000000,mode:'WBFM' as const,channelBandwidthHz:150000,squelch:0,gainDb:null,sampleFormat:'planar-f32-iq-normalized' as const};

it('RF spectrum must retain original RF bins after digital channel tuning', () => {
  const player: Player = {sampleRate:48000, play(){},setVolume(){},getVolume(){return 0;}};
  const demod = new Demodulator({player});
  demod.setFrequencyOffset(100000);
  const input = new SyntheticComplexTone({sampleRateHz:1024000,toneOffsetHz:125000}).generate(4096);
  let peakOffset = 0;
  const rds = new RdsMultiplexReceiver(()=>{}); rds.setEnabled(false);
  new AudioFirstRdsReceiver(demod, rds, {setSampleRate(){}, receiveSamples(block){
    const bins = new SpectrumAccumulator(4096,1).addWindow(block.I,block.Q)!;
    const peak = bins.indexOf(Math.max(...bins));
    peakOffset = (peak - 2048) * 250;
  }}).receiveSamples({...input,frequency:100000000});
  expect(peakOffset).toBe(125000);
});

it('a failed tune must not leave the previous backend active when restart is enabled',async()=>{
  let active = 0;
  const controller = new ReceiverController(()=>({
    start:async()=>{active++;return metadata;},stop:async()=>{active--;},setVolume(){},
    tune:async()=>{throw Error('outside capture');},configureMode:async()=>metadata,setGain:async()=>null,
  }));
  await controller.start({channelFrequencyHz:100000000,volume:0});
  await controller.tune(200000000);
  await controller.start({channelFrequencyHz:100000000,volume:0});
  expect(active).toBe(1);
});

it('audio telemetry must still update after tune advances the display generation',async()=>{
  let events!:ReceiverBackendEvents;
  const controller = new ReceiverController(e=>{events=e;return {
    start:async()=>metadata,stop:async()=>{},setVolume(){},tune:async()=>metadata,configureMode:async()=>metadata,setGain:async()=>null,
  };});
  await controller.start({channelFrequencyHz:100000000,volume:0});
  events.audioStateChanged('running');
  await controller.tune(100100000);
  events.audioStateChanged('suspended');
  expect(controller.getSnapshot().audioState).toBe('suspended');
});

it('recording parser must reject out-of-order gaps before replay can run backward',()=>{
  const fixture=createDeterministicRecordingFixture();
  fixture.metadata.knownGaps=[{afterSample:16000,missingSamples:1,reason:'a'},{afterSample:8000,missingSamples:1,reason:'b'}];
  expect(()=>parseRecording(JSON.stringify(fixture.metadata),fixture.data)).toThrow();
});

it('the built-in replay fixture must support a no-op channel tune',()=>{
  const m=createDeterministicRecordingFixture().metadata;
  expect(planChannelTune(m.centerFrequencyHz,m.selectedChannelFrequencyHz,m.sampleRateHz,m.channelBandwidthHz).hardwareRetuneRequired).toBe(false);
});

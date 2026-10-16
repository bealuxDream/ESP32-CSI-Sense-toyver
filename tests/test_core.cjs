const assert=require('node:assert/strict');
const {parseLine,parseNetwork,Signal,Network,BINS}=require('../viewer/core.js');
let count=0;
function test(name,fn){fn();console.log('PASS',name);count++;}
function line({seq=1,ms=100,scale=1,move=0,channel=6,format=1,invalid=0}={}){
 const iq=[];for(let j=0;j<64;j++)iq.push(Math.round(scale*(3+Math.cos(j))),Math.round(scale*(30+10*Math.sin(j*.2)+move*Math.sin(j*.5))));
 return ['CSI',seq,ms,-50,channel,invalid,format,...iq].join(',');
}
test('reject logs, truncated rows, malformed integers, out of range and zero CSI',()=>{
 assert.equal(parseLine('I (10) csi ready'),null);assert.equal(parseLine('CSI,1,2'),null);
 assert.equal(parseLine(line().replace('CSI,1','CSI,1.5')),null);
 const row=line().split(',');row[7]='128';assert.equal(parseLine(row.join(',')),null);
 assert.equal(parseLine(['CSI',1,1,-50,6,0,1,...Array(128).fill(0)].join(',')),null);
});
test('use consistent active bins and always exclude invalid first word',()=>{
 const a=parseLine(line()),row=line({invalid:1}).split(',');row[7]='127';row[8]='127';row[9]='127';row[10]='127';
 const b=parseLine(row.join(','));assert.equal(a.norm.length,51);assert.deepEqual(a.norm,b.norm);assert(!BINS.includes(0)&&!BINS.includes(1)&&!BINS.includes(32));
});
test('per-frame normalization removes a uniform amplitude scaling',()=>{
 const raw=Array.from({length:128},(_,i)=>i%2?20:3);
 const a=parseLine(['CSI',1,100,-50,6,0,1,...raw].join(','));
 const b=parseLine(['CSI',2,200,-40,6,0,1,...raw.map(x=>x*2)].join(','));
 const s=new Signal();s.add(a,0);const out=s.add(b,100);assert(out.motion<1e-12);
});
test('static calibration then frequency-shaped disturbance exceeds threshold',()=>{
 const s=new Signal();s.add(parseLine(line({seq:1,ms:1})),0);s.startCalibration(0);
 for(let i=1;i<=85;i++)s.add(parseLine(line({seq:i+1,ms:i*100+1})),i*100);
 assert.equal(s.calibrationResult,'ready');assert(s.threshold>=.02);assert(s.baseline);
 let out;for(let i=86;i<100;i++)out=s.add(parseLine(line({seq:i,ms:i*100,move:i%2?12:-12})),i*100);
 assert(out.ratio>1);
});
test('insufficient sampling does not produce a baseline',()=>{
 const s=new Signal();s.add(parseLine(line()),0);s.startCalibration(0);
 for(let i=1;i<=10;i++)s.add(parseLine(line({seq:i+1,ms:i*800})),i*800);
 assert.equal(s.calibrationResult,'insufficient');assert.equal(s.baseline,null);
});
test('channel changes and hardware reboot invalidate baseline immediately',()=>{
 for(const change of [{channel:11,format:0},{ms:1,format:0}]){
  const s=new Signal();s.add(parseLine(line({ms:200})),0);s.threshold=.1;s.baseline=Array(51).fill(1);
  const out=s.add(parseLine(line({seq:2,ms:300,...change})),100);assert(out.changed);assert.equal(s.threshold,null);
 }
});
test('interleaved packet formats preserve calibration and graph history',()=>{
 const s=new Signal();s.add(parseLine(line()),0);s.threshold=.1;s.baseline=Array(51).fill(1);
 const baseline=s.baseline;
 for(let i=1;i<=100;i++){
  const before=s.history.length,latest=s.latest;
  const out=s.add(parseLine(line({seq:i+1,ms:100+i*100,format:i%2?0:1})),i*100);
  assert.equal(out.changed,false);assert.equal(s.baseline,baseline);assert.equal(s.threshold,.1);
  if(i%2){assert(out.ignored);assert.equal(s.history.length,before);assert.equal(s.latest,latest);}
 }
 assert.equal(s.filteredFormats,50);assert.equal(s.total,51);assert.equal(s.history.length,51);
});
test('one stray frame during an eight-second calibration does not cancel it',()=>{
 const s=new Signal();s.add(parseLine(line()),0);s.startCalibration(0);
 for(let i=1;i<=85;i++)s.add(parseLine(line({seq:i+1,ms:100+i*100,format:i===50?0:1})),i*100);
 assert.equal(s.calibrationResult,'ready');assert(s.baseline);assert.equal(s.filteredFormats,1);
 assert.equal(s.total,85);assert.equal(s.history.length,85);
});
test('a persistent replacement format resets once after time and sample confirmation',()=>{
 const s=new Signal();s.add(parseLine(line()),0);s.threshold=.1;s.baseline=Array(51).fill(1);
 let changes=0;
 for(let i=1;i<=20;i++){
  const out=s.add(parseLine(line({seq:i+1,ms:100+i*100,format:0})),i*100);
  if(i<=10){assert(out.ignored);assert(s.baseline);}
  if(out.changed){changes++;assert.equal(out.changeReason,'format');assert(out.needsCalibration);}
 }
 assert.equal(changes,1);assert.equal(s.format,0);assert.equal(s.baseline,null);assert.equal(s.total,10);
});
test('a burst of other-format samples cannot force a switch or a false fresh timestamp',()=>{
 const s=new Signal();s.add(parseLine(line()),0);
 for(let i=0;i<30;i++)assert(s.add(parseLine(line({seq:i+2,ms:200+i,format:0})),100).ignored);
 assert.equal(s.format,1);assert.equal(s.lastTime,0);assert.equal(s.total,1);
 // The real reboot check still takes precedence over format filtering.
 const reboot=s.add(parseLine(line({seq:1,ms:1,format:0})),200);
 assert.equal(reboot.changeReason,'restart');assert.equal(s.format,0);
});
test('gaps cancel calibration and reset temporal difference',()=>{
 const s=new Signal();s.add(parseLine(line()),0);s.startCalibration(0);
 const out=s.add(parseLine(line({seq:2,ms:5000,move:10})),5000);
 assert(out.gap);assert.equal(out.motion,0);assert.equal(s.calibration,null);assert.equal(s.calibrationResult,'interrupted');
});
test('history and heatmap memory are bounded',()=>{
 const s=new Signal();for(let i=1;i<1000;i++)s.add(parseLine(line({seq:i,ms:i*100})),i*100);
 assert.equal(s.history.length,300);assert.equal(s.heat.length,240);
});
function net({ms=1000,connected=1,rssi=-50,channel=6,completed=20,received=18,timeouts=2,rttTotal=54,lastRtt=3,jitterTotal=12,jitterCount=4,disconnects=0,reconnects=0,reason=0,gateway='192.168.1.1'}={}){
 return ['NET',ms,connected,rssi,channel,completed,received,timeouts,rttTotal,lastRtt,jitterTotal,jitterCount,disconnects,reconnects,reason,gateway].join(',');
}
test('network parser rejects malformed data and inconsistent totals',()=>{
 assert(parseNetwork(net()));assert.equal(parseNetwork('NET,1,2'),null);
 assert.equal(parseNetwork(net({completed:21})),null);assert.equal(parseNetwork(net({gateway:'999.1.1.1'})),null);
 assert.equal(parseNetwork(net({connected:0,rssi:-50,channel:6})),null);
 assert.equal(parseNetwork(net({rttTotal:9007199254740992})),null);
 const f=parseNetwork(net({connected:0,rssi:-127,channel:0}));assert(f);assert.equal(f.rssi,null);
});
test('network window uses completed ICMP outcomes rather than CSI sequence gaps',()=>{
 const n=new Network();n.add(parseNetwork(net({ms:0,completed:0,received:0,timeouts:0,rttTotal:0,jitterTotal:0,jitterCount:0})),0);
 n.add(parseNetwork(net()),1000);const s=n.summary();
 assert.equal(s.loss,10);assert.equal(s.rtt,3);assert.equal(s.jitter,3);assert.equal(s.completed,20);assert.equal(s.duration,1);
});
test('network no outcomes means unknown loss and latency, not a perfect network',()=>{
 const n=new Network();n.add(parseNetwork(net()),0);const s=n.summary();
 assert.equal(s.loss,null);assert.equal(s.rtt,null);assert.equal(s.jitter,null);assert.equal(s.rssiStd,null);
});
test('network signal variation uses dB and excludes disconnected RSSI sentinel',()=>{
 const n=new Network();n.add(parseNetwork(net({ms:1000,rssi:-50})),1000);
 n.add(parseNetwork(net({ms:2000,rssi:-60})),2000);
 n.add(parseNetwork(net({ms:3000,connected:0,rssi:-127,channel:0,disconnects:1})),3000);
 const s=n.summary();assert.equal(s.rssiStd,5);assert.equal(s.rssiMin,-60);assert.equal(s.rssiMax,-50);assert.equal(n.latest.rssi,null);
});
test('network rolling window excludes older lifetime counters',()=>{
 const n=new Network();for(let i=0;i<60;i++)n.add(parseNetwork(net({ms:i*1000,completed:i*20,received:i*19,timeouts:i,rttTotal:i*57,jitterTotal:i*5,jitterCount:i*3})),i*1000);
 const s=n.summary();assert.equal(s.duration,30);assert.equal(s.completed,600);assert.equal(s.loss,5);assert.equal(s.rtt,3);assert(n.history.length<=32);
});
test('network counter reset, new gateway and serial gaps reset statistics window',()=>{
 for(const action of ['reboot','gateway','gap']){
  const n=new Network();n.add(parseNetwork(net()),1000);
  const frame=parseNetwork(net(action==='reboot'?{ms:1,completed:0,received:0,timeouts:0,rttTotal:0,jitterTotal:0,jitterCount:0}:action==='gateway'?{ms:2000,gateway:'192.168.2.1'}:{ms:8000}));
  const result=n.add(frame,action==='gap'?8000:2000);assert(result.reset);assert.equal(n.summary().loss,null);
 }
});
console.log(count+' meaningful CSI and network-metric checks passed.');

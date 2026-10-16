/* SPDX-License-Identifier: MIT */
(function(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.CSICore = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function() {
  'use strict';
  // S3 LLTF / HT20: bins 0..31,-32..-1. Use -26..-1,+2..+26.
  // DC/guard bins and the first 4 bytes are excluded consistently for all frames.
  const BINS = [...Array.from({length:26}, (_,i)=>i+38), ...Array.from({length:25},(_,i)=>i+2)];
  const CARRIERS = [...Array.from({length:26},(_,i)=>i-26), ...Array.from({length:25},(_,i)=>i+2)];
  const mean = a => a.reduce((s,v)=>s+v,0)/a.length;
  const rms = a => Math.sqrt(mean(a.map(v=>v*v)));
  function parseLine(line) {
    if (typeof line !== 'string' || line.length > 4096 || !line.startsWith('CSI,')) return null;
    const p = line.trim().split(',');
    if (p.length !== 135 || p.slice(1).some(x=>!/^[-]?\d+$/.test(x))) return null;
    const v = p.slice(1).map(Number);
    if (v.some(x=>!Number.isSafeInteger(x))) return null;
    const [seq,ms,rssi,channel,invalid,format,...iq] = v;
    if (seq < 1 || ms < 0 || rssi < -127 || rssi > 0 || channel < 1 || channel > 14 ||
        ![0,1].includes(invalid) || ![0,1].includes(format) || iq.some(x=>x < -128 || x > 127)) return null;
    const amp = BINS.map(i=>Math.hypot(iq[i*2],iq[i*2+1]));
    const m = mean(amp);
    if (m < 1) return null;
    return {seq,ms,rssi,channel,invalid,format,amp,norm:amp.map(a=>a/m),line:line.trim()};
  }
  function parseNetwork(line){
    if(typeof line!=='string'||line.length>1024||!line.startsWith('NET,'))return null;
    const p=line.trim().split(',');
    if(p.length!==16||p.slice(1,15).some(x=>!/^[-]?\d+$/.test(x)))return null;
    const v=p.slice(1,15).map(Number);
    if(v.some(x=>!Number.isSafeInteger(x)))return null;
    const [ms,connected,rssi,channel,completed,received,timeouts,rttTotal,lastRtt,jitterTotal,jitterCount,disconnects,reconnects,reason]=v;
    const ip=p[15].split('.');
    if(ip.length!==4||ip.some(x=>!/^\d{1,3}$/.test(x)||Number(x)>255))return null;
    if(ms<0||![0,1].includes(connected)||rssi < -127||rssi>0||channel<0||channel>14||
      [completed,received,timeouts,rttTotal,jitterTotal,jitterCount,disconnects,reconnects,reason].some(x=>x<0)||
      completed!==received+timeouts||jitterCount>received||lastRtt< -1||lastRtt>60000||
      (connected&&channel===0)||(!connected&&(channel!==0||rssi!==-127)))return null;
    return {kind:'network',ms,connected:!!connected,rssi:connected?rssi:null,channel,completed,received,timeouts,rttTotal,lastRtt,jitterTotal,jitterCount,disconnects,reconnects,reason,gateway:p[15],line:line.trim()};
  }
  const COUNTERS=['completed','received','timeouts','rttTotal','jitterTotal','jitterCount','disconnects','reconnects'];
  class Network {
    constructor(){this.reset();}
    reset(){this.history=[];this.latest=null;this.lastTime=null;}
    add(frame,now){
      const previous=this.latest;
      const rebooted=previous&&(frame.ms<previous.ms||COUNTERS.some(k=>frame[k]<previous[k]));
      const changed=previous&&frame.gateway!==previous.gateway;
      const gap=this.lastTime!==null&&now-this.lastTime>5000;
      if(rebooted||changed||gap)this.reset();
      this.latest=frame;this.lastTime=now;this.history.push({...frame,t:now});
      // Retain one snapshot before the window edge for counter deltas.
      while(this.history.length>2&&this.history[1].t<=now-30000)this.history.shift();
      if(this.history.length>120)this.history.splice(0,this.history.length-120);
      return {reset:!!(rebooted||changed||gap)};
    }
    summary(){
      const h=this.history;if(!h.length)return null;
      const a=h[0],b=h.at(-1),duration=(b.t-a.t)/1000;
      const completed=b.completed-a.completed,received=b.received-a.received,timeouts=b.timeouts-a.timeouts;
      const jitterCount=b.jitterCount-a.jitterCount;
      const rssis=h.filter(x=>x.connected).map(x=>x.rssi);
      const avg=rssis.length?mean(rssis):null;
      return {duration,completed,received,timeouts,
        loss:completed>0?timeouts/completed*100:null,
        rtt:received>0?(b.rttTotal-a.rttTotal)/received:null,
        jitter:jitterCount>0?(b.jitterTotal-a.jitterTotal)/jitterCount:null,
        rssiMean:avg,rssiStd:rssis.length>1?Math.sqrt(mean(rssis.map(v=>(v-avg)**2))):null,
        rssiMin:rssis.length?Math.min(...rssis):null,rssiMax:rssis.length?Math.max(...rssis):null};
    }
  }
  class Signal {
    constructor(){this.reset();}
    reset(){
      this.previous=null; this.lastTime=null; this.channel=null; this.format=null;
      this.baseline=null; this.threshold=null; this.calibration=null;
      this.smooth=[]; this.history=[]; this.heat=[]; this.total=0; this.latest=null;
      this.calibrationResult=null;
      this.pendingFormat=null;this.pendingFormatSince=null;this.pendingFormatCount=0;
      this.filteredFormats=0;
    }
    startCalibration(now){
      this.calibration={start:now,values:[],vectors:[]};
      this.baseline=null; this.threshold=null; this.calibrationResult=null;
      this.heat=[];
    }
    cancelCalibration(){ this.calibration=null; }
    add(frame, now){
      if(!frame || !Number.isFinite(now)) throw new Error('Invalid frame/time');
      const channelChanged=this.channel!==null && this.channel!==frame.channel;
      const restarted=this.latest && frame.ms < this.latest.ms;
      let changeReason=restarted?'restart':channelChanged?'channel':null;
      if(!changeReason && this.format!==null && this.format!==frame.format){
        // Routers interleave non-HT and HT packets. Keep one comparable stream;
        // a stray packet must not erase the graphs or interrupt calibration.
        if(this.pendingFormat!==frame.format){
          this.pendingFormat=frame.format;this.pendingFormatSince=now;this.pendingFormatCount=0;
        }
        this.pendingFormatCount++;
        // Adopt a new format only when the old one stops and the replacement
        // persists for >=1 second and >=5 samples. Batched packets cannot switch it.
        if(now-this.pendingFormatSince<1000 || this.pendingFormatCount<5){
          this.filteredFormats++;
          return {ignored:true,changed:false,changeReason:null,gap:false};
        }
        changeReason='format';
      }
      const hadCalibration=!!(this.baseline||this.calibration);
      if(changeReason)this.reset();
      this.pendingFormat=null;this.pendingFormatSince=null;this.pendingFormatCount=0;
      const gap=this.lastTime!==null && now-this.lastTime>1500;
      if(gap){this.previous=null;this.smooth=[];if(this.calibration){this.calibration=null;this.calibrationResult='interrupted';}}
      const delta=this.previous?rms(frame.norm.map((v,i)=>v-this.previous[i])):null;
      this.channel=frame.channel; this.format=frame.format;this.lastTime=now;
      this.previous=frame.norm.slice();this.latest=frame;this.total++;
      if(delta!==null){this.smooth.push(delta);if(this.smooth.length>5)this.smooth.shift();}
      const motion=this.smooth.length?mean(this.smooth):0;
      if(this.calibration && delta!==null){
        this.calibration.values.push(delta);this.calibration.vectors.push(frame.norm.slice());
        if(now-this.calibration.start>=8000){
          const c=this.calibration;this.calibration=null;
          if(c.values.length<30){this.calibrationResult='insufficient';}
          else {
            const mu=mean(c.values),sd=Math.sqrt(mean(c.values.map(v=>(v-mu)**2)));
            this.threshold=Math.max(0.02,mu+4*sd);
            this.baseline=frame.norm.map((_,i)=>mean(c.vectors.map(v=>v[i])));
            this.calibrationResult='ready';
            this.heat=[];
          }
        }
      }
      const ratio=this.threshold?motion/this.threshold:null;
      const residual=this.baseline?frame.norm.map((v,i)=>v-this.baseline[i]):frame.norm.map(v=>v-1);
      this.history.push({t:now,motion,ratio,rssi:frame.rssi});if(this.history.length>300)this.history.shift();
      this.heat.push(residual);if(this.heat.length>240)this.heat.shift();
      return {motion,ratio,ignored:false,changed:!!changeReason,changeReason,needsCalibration:!!changeReason&&hadCalibration,gap};
    }
  }
  return {BINS,CARRIERS,parseLine,parseNetwork,Signal,Network,mean,rms};
});

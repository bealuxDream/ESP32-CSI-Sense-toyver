/* SPDX-License-Identifier: MIT */
'use strict';
const $=id=>document.getElementById(id);
const signal=new CSICore.Signal();
const network=new CSICore.Network();
let view='csi',lastNetAt=0;
let mode='idle',port=null,reader=null,readPromise=null,connectBusy=false;
let timer=null,playbackFrames=[],playIndex=0,playStart=0;
let recording=null,rateTimes=[],lastFrameAt=0,logLines=[],lastCalResult=null;
let quizEnd=0,quizDone=false,toastTimer,renderAt=0;
const modeNames={idle:'未连接 · 无数据',live:'实时硬件数据',replay:'录制回放',simulation:'模拟数据 · 非硬件实测'};
function toast(msg){$('toast').textContent=msg;$('toast').classList.remove('hidden');clearTimeout(toastTimer);toastTimer=setTimeout(()=>$('toast').classList.add('hidden'),5000);}
function log(msg){logLines.push(msg);if(logLines.length>25)logLines.shift();$('logs').textContent=logLines.join('\n');}
function setMode(m){
  mode=m;$('mode').textContent=modeNames[m];$('mode').className='badge '+(m==='live'?'live':m==='idle'?'':'replay');
  $('footerMode').textContent='数据源：'+modeNames[m]+(m==='simulation'?'。仅用于熟悉界面，不能作为实验结果。':'。');
  $('connect').textContent=port?'断开开发板':'连接 ESP32-S3';
  $('connect').disabled=connectBusy||!navigator.serial;
  $('calibrate').disabled=m==='idle'||view==='network';$('gain').disabled=view==='network';$('record').disabled=m!=='live';$('stop').disabled=!['replay','simulation'].includes(m);
  $('hardwareToolbar').classList.toggle('hidden',view==='pc');
  if(view==='pc'){$('mode').textContent='电脑 Wi-Fi · 本机采样';$('mode').className='badge live';$('footerMode').textContent='数据源：这台 Windows 电脑的无线网卡与网关探测。';}
}
function changeView(v){view=v;$('csiView').classList.toggle('hidden',v!=='csi');$('networkView').classList.toggle('hidden',v!=='network');$('pcView').classList.toggle('hidden',v!=='pc');$('tabCsi').classList.toggle('active',v==='csi');$('tabNet').classList.toggle('active',v==='network');$('tabPc').classList.toggle('active',v==='pc');$('unsupported').classList.toggle('hidden',v==='pc'||!!navigator.serial&&window.isSecureContext);setMode(mode);if(v==='csi'&&mode==='idle')$('status').textContent=signal.latest?'当前未连接，图表保留最后的数据。':'先连接开发板，再保持环境静止，进行 8 秒静态校准。';PCWiFi.activate(v==='pc');}
$('tabCsi').onclick=()=>changeView('csi');$('tabNet').onclick=()=>changeView('network');$('tabPc').onclick=()=>changeView('pc');
function resetView(){signal.reset();network.reset();rateTimes=[];lastFrameAt=0;lastNetAt=0;lastCalResult=null;}
function stopPlayback(){clearInterval(timer);timer=null;playbackFrames=[];playIndex=0;if(mode==='replay'||mode==='simulation')setMode('idle');}
function exportRecord(){
  if(!recording)return;
  const rec=recording;recording=null;$('record').textContent='开始录制';
  if(!rec.frames.length){toast('没有收到有效硬件帧，未生成空录制。');return;}
  const body={version:2,source:'hardware',createdAt:new Date().toISOString(),
    note:'ESP32-S3 LLTF CSI plus 1Hz network telemetry. No Wi-Fi credentials.',frames:rec.frames};
  const url=URL.createObjectURL(new Blob([JSON.stringify(body)],{type:'application/json'}));
  const a=document.createElement('a');a.href=url;a.download='CSI-hardware-'+new Date().toISOString().replace(/[:.]/g,'-')+'.json';a.click();setTimeout(()=>URL.revokeObjectURL(url),5000);
  toast('已导出 '+rec.frames.length+' 帧真实硬件数据。');
}
function recordFrame(frame){
  if(recording&&mode==='live'){
    recording.frames.push({t:Math.round(performance.now()-recording.start),line:frame.line});
    if(recording.frames.length>=18000){exportRecord();toast('录制达到 18000 条，已自动导出。');}
  }
}
function ingestNetwork(frame,now){if(!frame)return;network.add(frame,now);lastNetAt=performance.now();recordFrame(frame);}
function handleFrame(frame,now){if(frame?.kind==='network')ingestNetwork(frame,now);else ingest(frame,now);}
function ingest(frame,now){
  if(!frame)return;
  const out=signal.add(frame,now);
  recordFrame(frame);
  if(out.ignored)return;
  lastFrameAt=performance.now();
  rateTimes.push(lastFrameAt);while(rateTimes.length&&lastFrameAt-rateTimes[0]>3000)rateTimes.shift();
  if(out.changed){
    lastCalResult=null;
    const reason={channel:'Wi-Fi 信道已改变',restart:'检测到板子重启或计时重置',format:'采集已持续切换到另一种帧格式'}[out.changeReason];
    log(reason+'，已重建 CSI 分析。');
    if(out.needsCalibration)toast(reason+'，请重新静态校准。');
  }
  if(signal.calibrationResult && signal.calibrationResult!==lastCalResult){
    lastCalResult=signal.calibrationResult;
    toast(lastCalResult==='ready'?'校准完成。现在可以挥手、起身或走动。':lastCalResult==='interrupted'?'采样中断，校准已取消。重新收到数据后再校准。':'校准期间数据不足 30 帧，请检查采样后重试。');
  }
}
async function disconnect(){
  if(recording)exportRecord();
  if(reader){try{await reader.cancel();}catch{}}
  if(readPromise){try{await readPromise;}catch{}}
}
async function readLive(p){
  let pending='';const decoder=new TextDecoder();
  try{
    reader=p.readable.getReader();
    while(true){
      const {value,done}=await reader.read();if(done)break;
      pending+=decoder.decode(value,{stream:true});
      let nl;
      while((nl=pending.indexOf('\n'))>=0){
        const line=pending.slice(0,nl).replace(/\r$/,'');pending=pending.slice(nl+1);
        const frame=CSICore.parseLine(line)||CSICore.parseNetwork(line);
        if(frame)handleFrame(frame,performance.now());
        else if(line&&!line.startsWith('CSI,')&&!line.startsWith('NET,'))log(line.slice(0,500));
      }
      if(pending.length>8192){pending='';log('丢弃超长或不完整串口行。');}
    }
  }catch(err){log('串口断开：'+err.message);toast('串口已断开。检查 USB 数据线后重新连接。');}
  finally{
    if(recording)exportRecord();
    if(reader){try{reader.releaseLock();}catch{}reader=null;}
    try{await p.close();}catch{}
    if(port===p)port=null;
    signal.cancelCalibration();setMode('idle');
    $('status').textContent='串口已断开。图表保留最后的数据；不会补充模拟数据。';
  }
}
$('connect').onclick=async()=>{
  if(port){await disconnect();return;}
  stopPlayback();connectBusy=true;setMode(mode);
  let selected;
  try{
    selected=await navigator.serial.requestPort();
    await selected.open({baudRate:115200,bufferSize:65536});
    try{await selected.setSignals({dataTerminalReady:false,requestToSend:false});}catch{}
    port=selected;resetView();setMode('live');
    $('status').textContent='串口已打开，等待 CSI。若长时间无数据，请展开下方设备日志。';
    readPromise=readLive(selected);
  }catch(err){if(selected){try{await selected.close();}catch{}}toast('连接未完成：'+err.message);}
  finally{connectBusy=false;setMode(mode);}
};
$('calibrate').onclick=()=>{
  if(!lastFrameAt||performance.now()-lastFrameAt>1500){toast('请先确认正在持续收到 CSI 数据，再开始校准。');return;}
  signal.startCalibration(performance.now());lastCalResult=null;
  toast('请保持板子、路由器、USB 线及周围环境静止 8 秒。');
};
$('record').onclick=()=>{
  if(recording){exportRecord();return;}
  if(mode!=='live'||!Math.max(lastFrameAt,lastNetAt)||performance.now()-Math.max(lastFrameAt,lastNetAt)>2000){toast('收到实时硬件数据后才能录制。');return;}
  recording={start:performance.now(),frames:[]};$('record').textContent='停止并导出录制';toast('开始录制真实硬件数据。建议录下：静止 → 活动 → 静止。');
};
$('load').onclick=()=>$('file').click();
$('file').onchange=async e=>{
  const file=e.target.files[0];e.target.value='';if(!file)return;
  if(file.size>30*1024*1024){toast('文件过大，请选择 30 MB 以内的录制。');return;}
  try{
    const data=JSON.parse(await file.text());
    if(![1,2].includes(data.version)||data.source!=='hardware'||!Array.isArray(data.frames)||data.frames.length<1||data.frames.length>18000)throw new Error('请选择本工具导出的硬件录制 JSON');
    let prev=-1;
    const frames=data.frames.map(x=>{
      const f=CSICore.parseLine(x.line)||CSICore.parseNetwork(x.line);
      if(!f||!Number.isFinite(x.t)||x.t<0||x.t<prev||x.t>3600000)throw new Error('录制时间或 CSI 数据无效');
      prev=x.t;return {t:x.t,frame:f};
    });
    await disconnect();stopPlayback();resetView();setMode('replay');
    playbackFrames=frames;playStart=performance.now()-frames[0].t;playIndex=0;
    timer=setInterval(()=>{
      const elapsed=performance.now()-playStart;
      while(playIndex<frames.length&&frames[playIndex].t<=elapsed){const x=frames[playIndex++];handleFrame(x.frame,playStart+x.t);}
      if(playIndex>=frames.length){clearInterval(timer);timer=null;signal.cancelCalibration();$('status').textContent='硬件录制回放结束。可重新导入播放，或连接开发板。';$('mode').textContent='录制回放 · 已结束';}
    },20);
    toast('正在按录制时间回放；旧版录制不包含 Ping 统计。');
  }catch(err){toast('无法导入：'+err.message);}
};
$('simulate').onclick=async()=>{
  await disconnect();stopPlayback();resetView();setMode('simulation');
  let i=0;const start=performance.now();
  const sim={completed:0,received:0,timeouts:0,rttTotal:0,jitterTotal:0,jitterCount:0,last:3};
  timer=setInterval(()=>{
    i++;const t=(performance.now()-start)/1000,active=t%24>=11&&t%24<18;
    const raw=[];
    for(let j=0;j<64;j++){
      const base=32+12*Math.sin(j*.17),wave=active?9*Math.sin(j*.39+t*5):.6*Math.sin(j*.2+t*2);
      raw.push(Math.round(4*Math.cos(j*.3)+Math.sin(t+j)),Math.round(base+wave));
    }
    ingest(CSICore.parseLine(['CSI',i,Math.round(t*1000),-48,6,0,1,...raw].join(',')),performance.now());
    if(i%10===0){
      const lost=active?2:0,rtt=active?35+Math.round(12*Math.sin(t)):3;
      sim.completed+=20;sim.received+=20-lost;sim.timeouts+=lost;sim.rttTotal+=rtt*(20-lost);
      sim.jitterTotal+=Math.abs(rtt-sim.last);sim.jitterCount++;sim.last=rtt;
      ingestNetwork(CSICore.parseNetwork(['NET',Math.round(t*1000),1,Math.round(-52+3*Math.sin(t*.4)-(active?14:0)),6,sim.completed,sim.received,sim.timeouts,sim.rttTotal,rtt,sim.jitterTotal,sim.jitterCount,0,0,0,'192.168.1.1'].join(',')),performance.now());
    }
  },100);
  toast('当前是模拟数据，仅用于熟悉投屏界面。11～18 秒有模拟扰动。');
};
$('stop').onclick=()=>{stopPlayback();signal.cancelCalibration();$('status').textContent='回放 / 模拟已停止，图表保留最后一帧。';};
$('fullscreen').onclick=async()=>{
  document.body.classList.toggle('fullMode');
  if(document.body.classList.contains('fullMode')){try{await document.documentElement.requestFullscreen();}catch{}}
  else if(document.fullscreenElement){try{await document.exitFullscreen();}catch{}}
};
document.addEventListener('fullscreenchange',()=>{if(!document.fullscreenElement)document.body.classList.remove('fullMode');});
$('round').onclick=()=>{quizEnd=performance.now()+10000;quizDone=false;$('round').disabled=true;$('reveal').disabled=true;$('quiz').textContent='请观众竞猜：A 静止 / B 活动';};
$('reveal').onclick=()=>{$('roundNote').textContent='现在请讲者口头揭晓自己刚才的动作，并解释：这次观察的是无线信道变化，曲线也会受其他物体、干扰和增益变化影响。';$('reveal').disabled=true;};
function canvasSetup(id){
  const c=$(id),r=c.getBoundingClientRect(),d=Math.min(devicePixelRatio||1,2);
  const w=Math.max(100,Math.round(r.width)),h=Math.max(80,Math.round(r.height));
  if(c.width!==w*d||c.height!==h*d){c.width=w*d;c.height=h*d;}
  const ctx=c.getContext('2d');ctx.setTransform(d,0,0,d,0,0);ctx.clearRect(0,0,w,h);return {ctx,w,h};
}
function empty(ctx,w,h){ctx.fillStyle='#7890af';ctx.font='14px Segoe UI,Microsoft YaHei';ctx.textAlign='center';ctx.fillText('等待数据 · 连接开发板或导入真实录制',w/2,h/2);}
let heatPointer=null;
$('heat').addEventListener('pointermove',event=>{
  const r=$('heat').getBoundingClientRect();
  heatPointer={x:(event.clientX-r.left)/r.width,y:(event.clientY-r.top)/r.height};
});
$('heat').addEventListener('pointerleave',()=>{heatPointer=null;});
function drawTrace(){
  const {ctx,w,h}=canvasSetup('trace');const a=signal.history;
  if(!a.length){empty(ctx,w,h);return;}
  const left=45,top=14,bottom=h-26,right=w-12;
  let max=Math.max(.08,(signal.threshold||0)*2,...a.map(x=>x.motion))*1.2;
  const start=a[a.length-1].t-30000;
  ctx.font='10px Segoe UI';ctx.textAlign='right';
  for(let i=0;i<=3;i++){const y=top+(bottom-top)*i/3;ctx.strokeStyle='#23344c';ctx.beginPath();ctx.moveTo(left,y);ctx.lineTo(right,y);ctx.stroke();ctx.fillStyle='#8ba1bf';ctx.fillText((max*(1-i/3)).toFixed(2),left-7,y+3);}
  if(signal.threshold){const y=bottom-signal.threshold/max*(bottom-top);ctx.strokeStyle='#ffbd77';ctx.setLineDash([5,5]);ctx.beginPath();ctx.moveTo(left,y);ctx.lineTo(right,y);ctx.stroke();ctx.setLineDash([]);}
  ctx.beginPath();a.forEach((v,i)=>{const x=left+(v.t-start)/30000*(right-left),y=bottom-v.motion/max*(bottom-top);if(i===0)ctx.moveTo(x,y);else ctx.lineTo(x,y);});
  ctx.strokeStyle='#5be3e3';ctx.lineWidth=2;ctx.stroke();ctx.lineWidth=1;ctx.fillStyle='#8ba1bf';ctx.textAlign='left';ctx.fillText('−30 秒',left,h-4);ctx.textAlign='right';ctx.fillText('现在',right,h-4);
}
function drawHeat(){
  const {ctx,w,h}=canvasSetup('heat');const a=signal.heat;
  const readout=$('heatReadout');
  readout.textContent='将鼠标移入色块，查看子载波编号、帧位置和偏差。';
  if(!a.length){empty(ctx,w,h);readout.textContent='等待 CSI 数据；收到数据后可逐行查看子载波。';return;}
  const gain=Number($('gain').value),left=45,right=w-12,top=5,bottom=h-27;
  const rows=51,columns=240,cw=(right-left)/columns,rh=(bottom-top)/rows;
  ctx.fillStyle='#0b1525';ctx.fillRect(left,top,right-left,bottom-top);
  a.forEach((col,x)=>col.forEach((v,y)=>{
    const s=Math.max(-1,Math.min(1,v*gain)),t=Math.abs(s);
    const base=[15,33,54],end=s>=0?[255,181,105]:[48,147,242];
    ctx.fillStyle=`rgb(${base.map((b,i)=>Math.round(b+(end[i]-b)*t)).join(',')})`;
    ctx.fillRect(left+(columns-a.length+x)*cw,top+(rows-1-y)*rh,Math.ceil(cw)+.1,Math.ceil(rh)+.1);
  }));
  ctx.fillStyle='#8ba1bf';ctx.font='10px Segoe UI';ctx.textAlign='right';
  for(const carrier of [26,13,2,-13,-26]){
    const row=CSICore.CARRIERS.indexOf(carrier),y=top+(rows-row-.5)*rh;
    ctx.fillText(carrier>0?'+'+carrier:String(carrier),left-6,Math.max(top+9,Math.min(bottom,y+3)));
  }
  ctx.textAlign='left';ctx.fillText('子载波编号 ↑',left,h-4);ctx.textAlign='right';ctx.fillText('最近 240 帧 →',right,h-4);
  if(heatPointer){
    const px=heatPointer.x*w,py=heatPointer.y*h;
    if(px>=left&&px<right&&py>=top&&py<bottom){
      const column=Math.floor((px-left)/cw)-(columns-a.length);
      const row=rows-1-Math.floor((py-top)/rh);
      if(column<0){readout.textContent='此处尚无帧数据，请移到右侧已有颜色的区域。';return;}
      const carrier=CSICore.CARRIERS[row],value=a[column][row];
      const x=left+(columns-a.length+column)*cw,y=top+(rows-1-row)*rh;
      ctx.strokeStyle='#ecf4ff';ctx.lineWidth=1;ctx.setLineDash([3,3]);
      ctx.strokeRect(left,y,right-left,rh);ctx.strokeRect(x,top,cw,bottom-top);ctx.setLineDash([]);
      const reference=signal.baseline?'相对静态基线':'相对帧内均值 1（未校准）';
      readout.textContent='子载波 '+(carrier>0?'+'+carrier:carrier)+' · 窗口第 '+(column+1)+' / '+a.length+' 帧（距最新 '+(a.length-1-column)+' 帧） · '+reference+'：'+(value>=0?'+':'')+value.toFixed(3)+'（无单位，未乘显示增益）';
    }
  }
}
function netPlot(id,values,min,max,unit,markTimeouts=false,history=network.history){
  const {ctx,w,h}=canvasSetup(id),hist=history;
  if(!hist.length){empty(ctx,w,h);return;}
  const left=48,right=w-14,top=14,bottom=h-27,start=hist.at(-1).t-30000;
  ctx.font='10px Segoe UI';ctx.textAlign='right';
  for(let i=0;i<=4;i++){
    const y=top+(bottom-top)*i/4,value=max-(max-min)*i/4;
    ctx.strokeStyle='#23344c';ctx.beginPath();ctx.moveTo(left,y);ctx.lineTo(right,y);ctx.stroke();
    ctx.fillStyle='#8ba1bf';ctx.fillText(value.toFixed(0),left-7,y+4);
  }
  ctx.save();ctx.beginPath();ctx.rect(left,top,right-left,bottom-top);ctx.clip();
  ctx.lineWidth=2;ctx.strokeStyle='#5be3e3';ctx.beginPath();let started=false;
  hist.forEach((p,i)=>{
    const value=values[i];if(value===null||!Number.isFinite(value)){started=false;return;}
    const x=left+(p.t-start)/30000*(right-left),y=bottom-(value-min)/(max-min)*(bottom-top);
    if(!started)ctx.moveTo(x,y);else ctx.lineTo(x,y);started=true;
  });ctx.stroke();ctx.lineWidth=1;
  if(markTimeouts){hist.forEach((p,i)=>{const failed=p.probeStatus?['timeout','error'].includes(p.probeStatus):i>0&&p.timeouts>hist[i-1].timeouts;if(!failed)return;const x=left+(p.t-start)/30000*(right-left);ctx.fillStyle='#ffbd77';ctx.fillRect(x-2,top,4,bottom-top);});}
  ctx.restore();ctx.fillStyle='#8ba1bf';ctx.textAlign='left';ctx.fillText('−30 秒 / '+unit,left,h-4);ctx.textAlign='right';ctx.fillText('现在',right,h-4);
}
function drawNetwork(now){
  const f=network.latest,s=network.summary(),stale=!lastNetAt||now-lastNetAt>2500||mode==='idle';
  const live=!!f&&!stale,fmt=v=>v===null||v===undefined?'—':v.toFixed(1);
  $('netRssi').textContent=live&&f.connected?f.rssi:'—';
  $('netRtt').textContent=live&&s?fmt(s.rtt):'—';$('netLoss').textContent=live&&s?fmt(s.loss):'—';$('netJitter').textContent=live&&s?fmt(s.jitter):'—';
  const strength=live&&f.connected?(f.rssi>=-60?'较强':f.rssi>=-75?'中等':'较弱'):null;
  $('netStrength').textContent=strength?strength+' · 分档仅供演示参考':!f?'等待 NET 状态，请使用新版固件 / 录制':stale?'网络状态采样已暂停':'Wi-Fi 未连接';
  const bars=live&&f.connected?(f.rssi>=-50?4:f.rssi>=-60?3:f.rssi>=-75?2:1):0;
  [...$('netBars').children].forEach((el,i)=>el.classList.toggle('on',i<bars));
  $('netLast').textContent=live?(f.connected?(f.lastRtt<0?'最近一次：超时或暂无结果':f.lastRtt===0?'最近一次：<1 ms（毫秒计时）':'最近一次：'+f.lastRtt+' ms'):'当前已断开；上方为窗口历史'):'最近一次：—';
  $('netCounts').textContent=s?'窗口内 '+s.completed+' 次完成探测 / '+s.timeouts+' 次超时'+(s.completed<20?' · 样本较少':''):'等待探测结果';
  $('netWindow').textContent=s?'窗口实际 '+s.duration.toFixed(1)+' 秒 / 目标约 30 秒':'统计窗口：等待数据';
  $('netLink').textContent='连接状态：'+(!f?'等待数据':stale?'数据已暂停':f.connected?'已连接 · 信道 '+f.channel:'Wi-Fi 已断开');
  $('netGateway').textContent='探测网关：'+(f?f.gateway:'—');
  $('netVariation').textContent=s?.rssiStd!==null&&s?.rssiStd!==undefined?'RSSI 波动：σ '+s.rssiStd.toFixed(1)+' dB / 范围 '+s.rssiMin+'～'+s.rssiMax+' dBm':'RSSI 波动：等待更多样本';
  $('netReconnects').textContent='本次开机掉线 / 重连：'+(f?f.disconnects+' / '+f.reconnects+(f.reason?' · 最近原因码 '+f.reason:''):'—');
  if(view==='network'){
    $('dot').classList.toggle('on',live);
    $('status').textContent=!f?(signal.latest?'当前固件或旧版录制没有网络统计，请烧录新版固件或导入新版录制。':'连接板子后将独立接收每秒一次的网络状态；不需要 CSI 校准。'):stale?'网络状态已暂停，图表保留历史；重新连接可继续采样。':mode==='simulation'?'当前为模拟网络数据，仅用于熟悉界面。':!f.connected?'板子 Wi-Fi 已断开，正在尝试重连；USB 状态输出仍在继续。':'正在观察 ESP32-S3 到本地网关的链路，统计窗口约 30 秒。';
  }
  const hist=network.history;
  netPlot('netSignal',hist.map(x=>x.connected?x.rssi:null),-100,-20,'dBm');
  const rtts=hist.map((x,i)=>{if(!i)return null;const prev=hist[i-1],n=x.received-prev.received;return n>0?(x.rttTotal-prev.rttTotal)/n:null;});
  netPlot('netLatency',rtts,0,Math.max(20,...rtts.filter(x=>x!==null))*1.2,'ms',true);
}
function draw(now){
  requestAnimationFrame(draw);if(now-renderAt<100)return;renderAt=now;
  if(view==='pc'){PCWiFi.draw(now);return;}
  const f=signal.latest,stale=!!lastFrameAt&&now-lastFrameAt>2000;
  if(signal.calibration&&now-signal.calibration.start>12000){signal.cancelCalibration();toast('校准等待超时，请检查数据流后重试。');}
  $('frames').textContent=signal.total.toLocaleString();$('rssi').textContent=f?f.rssi+' dBm':'—';$('channel').textContent=f?f.channel:'—';
  const dt=rateTimes.length>1?(rateTimes.at(-1)-rateTimes[0])/1000:0;
  $('hz').textContent=!stale&&dt?((rateTimes.length-1)/dt).toFixed(1)+' Hz':'—';
  const last=signal.history.at(-1),ratio=last?.ratio;
  $('ratio').textContent=ratio==null||stale?'—':Math.min(99.9,ratio).toFixed(1);
  $('meter').style.width=ratio==null||stale?'0%':Math.min(100,ratio/3*100)+'%';
  $('meter').style.background=ratio>1?'#ffbd77':'#5be3e3';
  let state='等待信号';
  if(signal.calibration)state='静态校准中…';
  else if(f)state=stale?'数据已暂停':ratio==null?'待静态校准':ratio>1?'信号变化明显':'接近静态基线';
  $('state').textContent=state;$('state').style.color=stale?'#96aac4':ratio>1?'#ffbd77':'#5be3e3';
  $('dot').classList.toggle('on',!!f&&!stale&&mode!=='idle');
  if(signal.calibration)$('status').textContent='静态校准：还需约 '+Math.max(0,Math.ceil((8000-(now-signal.calibration.start))/1000))+' 秒，请不要移动。';
  else if(mode!=='idle'&&f){
    $('status').textContent=stale?'已超过 2 秒未收到新帧。若是回放结束可重新导入；实时模式请检查日志和 Wi-Fi。':mode==='simulation'?'模拟数据正在运行，不能用作实际感知结论。':recording?'正在录制真实硬件数据 · '+recording.frames.length+' 帧':signal.baseline?'校准完成。请固定板子和 USB 线，再挥手、起身或走动。':'已收到 CSI。请先保持静止，点击“静态校准”。';
  }
  $('heatTitle').textContent=signal.baseline?'CSI 频率指纹 · 相对静态基线':'CSI 频率指纹 · 未校准 / 帧内归一化';
  if(quizEnd&&!quizDone){const n=Math.ceil((quizEnd-now)/1000);if(n>0)$('roundNote').textContent='竞猜剩余 '+n+' 秒。请在聊天中发送 A 或 B。';else{quizDone=true;$('round').disabled=false;$('reveal').disabled=false;$('roundNote').textContent='时间到。请先收集答案，再点击揭晓。';}}
  if(view==='network')drawNetwork(now);else{drawTrace();drawHeat();}
}
$('unsupported').classList.toggle('hidden',!!navigator.serial&&window.isSecureContext);
setMode('idle');requestAnimationFrame(draw);
// Expose only signal inspection for local automated verification; no simulated source is started.
window.CSIDemo={signal,network,ingest,ingestNetwork,getMode:()=>mode};

/* SPDX-License-Identifier: MIT */
'use strict';
const PCWiFi=(()=>{
  let active=false,paused=false,timer=null,controller=null,data=null,lastReceived=0,error='',generation=0;
  async function poll(token){
    if(!active||paused||token!==generation)return;
    const requestController=new AbortController();controller=requestController;
    const timeout=setTimeout(()=>requestController.abort(),4000);
    try{
      const response=await fetch('/api/pc-wifi',{cache:'no-store',signal:requestController.signal});
      if(!response.ok)throw new Error(response.status===404?'本地服务尚未更新，请重新启动 start_viewer.cmd。':'本地 Wi-Fi 服务返回 '+response.status);
      const result=await response.json();
      if(token!==generation)return;
      if(result.source!=='windows-wlan'||!Array.isArray(result.samples))throw new Error('本地服务返回的数据格式不正确。');
      data=result;lastReceived=performance.now();error='';
    }catch(err){if(token===generation&&active&&!paused)error=err.name==='AbortError'?'读取本地服务超时，正在重试。':err.message;}
    finally{
      clearTimeout(timeout);
      if(token===generation){controller=null;if(active&&!paused)timer=setTimeout(()=>poll(token),1000);}
    }
  }
  function restart(){generation++;clearTimeout(timer);controller?.abort();controller=null;if(active&&!paused)poll(generation);}
  function activate(value){active=value;restart();}
  $('pcToggle').onclick=()=>{paused=!paused;restart();};
  function draw(now){
    const f=data?.latest,s=data?.summary,rows=data?.samples||[];
    const fresh=!!f?.sampledAt&&now-lastReceived<5000&&Date.now()-f.sampledAt<5000&&!error&&!paused;
    const linked=fresh&&f.status==='connected',fmt=n=>n===null||n===undefined?'—':n.toFixed(1);
    $('pcToggle').textContent=paused?'继续监测':'暂停监测';
    const states={disconnected:'未连接',no_adapter:'无无线网卡',permission:'需要系统权限',unsupported:'系统不支持',error:'采样异常'};
    $('mode').textContent=paused?'电脑 Wi-Fi · 已暂停':error?'电脑 Wi-Fi · 服务异常':linked?'电脑 Wi-Fi · 本机实测':'电脑 Wi-Fi · '+(states[f?.status]||'等待数据');
    $('mode').className='badge '+(linked?'live':'');
    $('dot').classList.toggle('on',linked);
    $('status').textContent=paused?'电脑 Wi-Fi 监测已暂停，图表保留最近数据。':error||f?.message||'正在连接本机 Wi-Fi 采样服务…';
    if(!paused&&!error&&f?.sampledAt&&!fresh)$('status').textContent='电脑 Wi-Fi 采样暂未更新，正在等待本地服务。';
    $('pcQuality').textContent=linked?fmt(f.quality):'—';
    $('pcRssi').textContent=linked?(f.rssi===null?'驱动未提供 RSSI，使用信号质量 %':'实际 RSSI：'+f.rssi+' dBm'):'RSSI：—';
    $('pcRtt').textContent=fresh?fmt(s?.rtt):'—';$('pcLoss').textContent=fresh?fmt(s?.loss):'—';$('pcJitter').textContent=fresh?fmt(s?.jitter):'—';
    const probe=f?.probeStatus;
    $('pcProbe').textContent=!fresh?'最近一次：—':probe==='ok'?(rows.at(-1)?.rtt===0?'最近一次：<1 ms（毫秒计时）':'最近一次：'+rows.at(-1)?.rtt+' ms'):probe==='timeout'?'最近一次：超时':probe==='error'?'最近一次：失败，系统状态码 '+f.probeCode:'当前没有可探测的 Wi-Fi IPv4 网关';
    $('pcCounts').textContent=s?'窗口内 '+s.attempts+' 次探测 / '+s.failures+' 次失败'+(s.attempts<20?' · 样本较少':''):'等待探测结果';
    $('pcWindow').textContent=s?'窗口实际 '+fmt(s.duration)+' 秒 / 目标约 30 秒':'统计窗口：等待数据';
    $('pcSsid').textContent=linked?f.ssid||'未命名网络':'—';$('pcAdapter').textContent=f?.adapter||'—';
    $('pcRoute').textContent=linked?'信道 '+(f.channel??'未知')+' / '+(f.gateway||'暂无 IPv4 网关'):'—';
    $('pcRates').textContent=linked?fmt(f.rxMbps)+' / '+fmt(f.txMbps)+' Mbps':'—';
    $('pcVariation').textContent=s?.qualityMin!=null?s.qualityMin+'～'+s.qualityMax+' %':'—';
    $('pcSampleTime').textContent=f?.sampledAt?new Date(f.sampledAt).toLocaleTimeString():'—';
    let failures=0;
    const history=rows.map(p=>({...p,timeouts:failures+=['timeout','error'].includes(p.probeStatus)?1:0}));
    if(!history.length){for(const id of ['pcSignal','pcLatency']){const {ctx,w,h}=canvasSetup(id);ctx.fillStyle='#7890af';ctx.font='14px Segoe UI,Microsoft YaHei';ctx.textAlign='center';ctx.fillText('等待这台电脑的 Wi-Fi 数据',w/2,h/2);}return;}
    netPlot('pcSignal',history.map(p=>p.quality??null),0,100,'%',false,history);
    const rtts=history.map(p=>p.rtt);
    netPlot('pcLatency',rtts,0,Math.max(20,...rtts.filter(n=>Number.isFinite(n)))*1.2,'ms',true,history);
  }
  return {activate,draw};
})();

'use strict';
const $ = id => document.getElementById(id);
const jobs = [];
const SESSION_KEY = 'fileBridgeSession';
function storedSession() {
  try {
    const value=JSON.parse(sessionStorage.getItem(SESSION_KEY));
    return value && typeof value.apiBase==='string' && typeof value.token==='string'?value:null;
  } catch {return null;}
}
function saveSession(value) {
  try {
    sessionStorage.removeItem('fileBridgeToken');
    if(value) sessionStorage.setItem(SESSION_KEY,JSON.stringify(value));
    else sessionStorage.removeItem(SESSION_KEY);
  } catch {/* Login still works if the browser disables storage. */}
}
let savedSession=storedSession();
let token = '', apiBase = '', loginBusy = false, loginController = null, sessionVersion = 0;
let connected = false, running = false, paused = false, controller = null;
let limits = {max_file_size:50_000_000_000, chunk_size:1_000_000};
$('serverUrl').value=savedSession?.apiBase || globalThis.FILE_BRIDGE_CONFIG?.apiBase ||
  (window.location.hostname.endsWith('.github.io')?'':window.location.origin);

function normalizeBackend(value) {
  let url;
  try {url=new URL(value.trim());} catch {throw new Error('请输入完整的接收服务地址，例如 https://upload.example.com。');}
  if(!['https:','http:'].includes(url.protocol) || !url.hostname || url.username || url.password ||
     url.href.includes('?') || url.href.includes('#') || value.includes('\\')) {
    throw new Error('服务地址只支持 HTTP(S)，不能包含账号、密码、查询参数或片段。');
  }
  if(window.location.protocol==='https:' && url.protocol!=='https:') {
    throw new Error('当前网页使用 HTTPS，接收服务也必须使用 HTTPS 地址。');
  }
  return url.href.replace(/\/+$/,'');
}

function showLogin(message='') {
  $('loginView').hidden=false;$('appView').hidden=true;
  $('loginError').textContent=message;$('loginError').hidden=!message;
}

function endSession(message='') {
  sessionVersion++;
  connected=false;token='';apiBase='';saveSession(null);
  controller?.abort();loginController?.abort();
  jobs.length=0;paused=false;
  $('token').value='';$('serverAddress').textContent='登录后显示';
  $('destination').textContent='登录后显示';$('historyRows').replaceChildren();
  $('connectionDot').className='tiny-dot offline';$('connectionText').textContent='等待登录';
  $('destinationBadge').className='tag';$('destinationBadge').textContent='待连接';
  renderQueue();notice('');showLogin(message);
}

function bytes(n) {
  if(n < 1000) return n + ' B';
  const units=['KB','MB','GB','TB']; let i=-1;
  do {n/=1000;i++;} while(n>=1000 && i<units.length-1);
  return n.toFixed(n>=100 ? 0 : n>=10 ? 1 : 2) + ' ' + units[i];
}
function formatDuration(seconds) {
  if(!Number.isFinite(seconds) || seconds<0)return '计算中';
  if(seconds<1)return '少于1秒';
  const total=Math.ceil(seconds),days=Math.floor(total/86400),hours=Math.floor(total/3600)%24,
    minutes=Math.floor(total/60)%60,secs=total%60;
  if(days)return `${days}天${hours?hours+'小时':''}`;
  if(hours)return `${hours}小时${minutes?minutes+'分':''}`;
  if(minutes)return `${minutes}分${secs?secs+'秒':''}`;
  return `${secs}秒`;
}
function elapsedSeconds(job,now=performance.now()) {
  return ((job.elapsedMs||0)+(job.activeSince==null?0:Math.max(0,now-job.activeSince)))/1000;
}
function freezeTiming(job,now=performance.now()) {
  if(job.activeSince!=null) {
    job.elapsedMs=(job.elapsedMs||0)+Math.max(0,now-job.activeSince);
    job.activeSince=null;
  }
}
function beginPhase(job,name,total,now=performance.now()) {
  job.phase=name;
  job.timingPhase={total,done:0,started:now,lastProgress:now,samples:[{at:now,bytes:0}]};
}
function recordPhaseProgress(job,size,now=performance.now()) {
  const phase=job.timingPhase;
  phase.done+=size;phase.lastProgress=now;
  phase.samples.push({at:now,bytes:phase.done});
}
function phaseRate(job,now=performance.now()) {
  const phase=job.timingPhase;
  // Allow a short warm-up and stop extrapolating when acknowledgements stall.
  if(!phase || phase.done<=0 || now-phase.started<2000 || now-phase.lastProgress>15000)return null;
  while(phase.samples.length>1 && phase.samples[1].at<=now-15000)phase.samples.shift();
  const baseline=phase.samples[0],seconds=(now-baseline.at)/1000;
  return seconds>0 && phase.done>baseline.bytes?(phase.done-baseline.bytes)/seconds:null;
}
function timingText(job,now=performance.now()) {
  if(job.state==='waiting')return '开始传输后估算剩余时间';
  const elapsed=`已用时 ${formatDuration(elapsedSeconds(job,now))}`;
  if(job.state==='complete')return elapsed;
  if(job.state==='paused')return elapsed+' · 已暂停，继续后重新估算';
  if(job.state==='error')return elapsed+' · 传输中断，重试后重新估算';
  if(job.phase==='finalizing')return elapsed+' · 正在保存文件';
  if(job.phase==='preparing')return elapsed+' · 正在识别文件';
  const rate=phaseRate(job,now),label=job.phase==='verifying'?'预计校验剩余':'预计上传剩余';
  if(!rate)return elapsed+' · '+label+'：计算中';
  return elapsed+' · '+label+'：约 '+formatDuration(Math.max(0,job.timingPhase.total-job.timingPhase.done)/rate);
}
function notice(message, type='') {
  $('notice').textContent=message;
  $('notice').className='notice '+type;
  $('notice').hidden=!message;
}
function abortError() {return new DOMException('传输已暂停','AbortError');}
function checkAbort(signal) {if(signal?.aborted) throw abortError();}
function delay(ms, signal) {
  return new Promise((resolve,reject)=>{
    checkAbort(signal);
    const abort=()=>{clearTimeout(timer);reject(abortError());};
    const timer=setTimeout(()=>{signal?.removeEventListener('abort',abort);resolve();},ms);
    signal?.addEventListener('abort',abort,{once:true});
  });
}
async function api(path, {method='GET', body, headers={}, signal, attempts=1, auth}={}) {
  const credentials=auth || {apiBase,token};
  const target=credentials.apiBase+path;
  for(let attempt=0;attempt<attempts;attempt++) {
    checkAbort(signal);
    const timeout=new AbortController();
    const onAbort=()=>timeout.abort();
    signal?.addEventListener('abort',onAbort,{once:true});
    const timer=setTimeout(()=>timeout.abort(),150_000);
    try {
      const response=await fetch(target,{method,body,signal:timeout.signal,
        headers:{Authorization:'Bearer '+credentials.token,...headers},cache:'no-store',
        credentials:'omit',redirect:'error',mode:'cors'});
      const result=await response.json().catch(()=>({detail:'服务器返回了无法识别的响应。'}));
      if(!response.ok) {
        const message=typeof result.detail==='string'?result.detail:'请求参数不正确。';
        const error=new Error(message);error.status=response.status;
        if(response.status===401 && !auth && connected) endSession('登录已失效，请重新输入访问密钥。');
        throw error;
      }
      return result;
    } catch(error) {
      checkAbort(signal);
      const retryable=!error.status || [408,429,500,502,503,504].includes(error.status);
      if(!retryable || attempt===attempts-1) {
        if(error.name==='AbortError') throw new Error('请求超时，可点击继续上传。');
        throw error;
      }
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort',onAbort);
    }
    await delay(Math.min(800*2**attempt,8000),signal);
  }
}
async function jsonApi(path, data, options={}) {
  return api(path,{method:'POST',body:JSON.stringify(data),headers:{'Content-Type':'application/json'},...options});
}
function updateControls() {
  $('startButton').disabled=!running && (!connected || !jobs.some(j=>j.state!=='complete'));
  $('startButton').textContent=running?'暂停上传':paused?'继续上传 ↥':'开始上传 ↥';
  $('clearButton').disabled=running;
  $('concurrency').disabled=running;
  $('fresh').disabled=running;
  $('logoutButton').disabled=running || loginBusy;
  $('loginButton').disabled=loginBusy;
  $('serverUrl').disabled=loginBusy;
  $('token').disabled=loginBusy || running;
  document.querySelectorAll('.delete-task').forEach(button=>button.disabled=running);
  $('queueSummary').textContent=jobs.length?`${jobs.length} 个文件 · 共 ${bytes(jobs.reduce((s,j)=>s+j.file.size,0))}`:'尚未选择文件';
}
function renderQueue() {
  $('queue').replaceChildren();
  jobs.forEach(job=>{
    const wrap=document.createElement('div');wrap.className='queue-item';
    const line=document.createElement('div');line.className='file-line';
    const icon=document.createElement('span');icon.className='file-icon';icon.textContent='▤';
    const details=document.createElement('div');details.className='file-details';
    const name=document.createElement('div');name.className='file-name';name.textContent=job.file.name;name.title=job.file.name;
    const meta=document.createElement('div');meta.className='file-meta';
    const timing=document.createElement('div');timing.className='file-timing';
    const state=document.createElement('div');state.className='file-state';
    const progress=document.createElement('div');progress.className='progress';
    const fill=document.createElement('div');fill.className='progress-fill';
    progress.setAttribute('role','progressbar');progress.setAttribute('aria-label',job.file.name+' 上传进度');progress.setAttribute('aria-valuemin','0');progress.setAttribute('aria-valuemax','100');
    progress.append(fill);details.append(name,meta,timing);line.append(icon,details,state);wrap.append(line,progress);$('queue').append(wrap);
    job.ui={meta,timing,state,fill,progress};paintJob(job);
  });
  updateControls();
}
function paintJob(job) {
  if(!job.ui) return;
  const percent=job.file.size?Math.min(100,100*(job.done||0)/job.file.size):job.state==='complete'?100:0;
  job.ui.fill.style.width=percent+'%';job.ui.progress.setAttribute('aria-valuenow',Math.floor(percent));
  const now=performance.now(),rate=job.state==='uploading'?phaseRate(job,now):null;
  const speed=rate && job.phase==='uploading'?` · ${bytes(rate)}/s`:'';
  job.ui.meta.textContent=`${bytes(job.done||0)} / ${bytes(job.file.size)}${speed}`;
  job.ui.timing.textContent=timingText(job,now);
  job.ui.state.textContent=job.message||'等待上传';
  job.ui.state.className='file-state'+(job.state==='error'?' error':'');
}
function addFiles(files) {
  let rejected=0;
  for(const file of files) {
    if(file.size>limits.max_file_size){rejected++;continue;}
    if(jobs.some(j=>j.file.name===file.name && j.file.size===file.size && j.file.lastModified===file.lastModified)) continue;
    jobs.push({file,state:'waiting',done:0,message:'等待上传',fresh:null});
  }
  if(rejected) notice(`${rejected} 个文件超过 50 GB，已跳过。`,'error');
  else notice('');
  renderQueue();
}
async function fingerprint(file,signal) {
  const span=64*1024;
  const offsets=[0,Math.max(0,Math.floor(file.size/2)-Math.floor(span/2)),Math.max(0,file.size-span)];
  const hashes=[];
  for(const offset of offsets) {
    checkAbort(signal);
    hashes.push(await sha256(await file.slice(offset,Math.min(offset+span,file.size)).arrayBuffer()));
  }
  return sha256(new TextEncoder().encode(JSON.stringify([file.name,file.size,file.lastModified,...hashes])));
}
async function transfer(job,signal) {
  job.activeSince=performance.now();job.phase='preparing';job.timingPhase=null;
  job.state='uploading';job.message='识别文件，查找续传进度…';paintJob(job);
  job.fingerprint ||= await fingerprint(job.file,signal);
  job.requestKey ||= Array.from(crypto.getRandomValues(new Uint8Array(16)),x=>x.toString(16).padStart(2,'0')).join('');
  checkAbort(signal);
  const info=await jsonApi('/api/uploads',{name:job.file.name,size:job.file.size,fingerprint:job.fingerprint,fresh:job.fresh??$('fresh').checked,request_key:job.requestKey},{signal,attempts:3});
  // A successful create makes subsequent starts resume this task, even if fresh was checked.
  job.fresh=false;job.id=info.id;job.done=info.received_bytes;job.transferred=0;
  const bitmap=Uint8Array.from(atob(info.bitmap),c=>c.charCodeAt(0));
  const has=index=>!!(bitmap[index>>3]&(1<<(index%8)));
  const hashPages=new Map();
  function hashPage(index) {
    const start=Math.floor(index/512)*512;
    if(!hashPages.has(start)) hashPages.set(start,api(`/api/uploads/${info.id}/hashes?start=${start}&limit=512`,{signal,attempts:3}));
    return hashPages.get(start);
  }
  async function runPhase(name,total,totalChunks) {
    beginPhase(job,name,total);paintJob(job);
    let cursor=0,checked=0;
    const worker=async()=>{
      while(cursor<info.total) {
        checkAbort(signal);
        const index=cursor++;
        if(has(index)!==(name==='verifying'))continue;
        const chunk=job.file.slice(index*info.chunk_size,Math.min((index+1)*info.chunk_size,job.file.size));
        const data=await chunk.arrayBuffer();
        checkAbort(signal);
        const digest=await sha256(data);
        checkAbort(signal);
        if(has(index)) {
          const hashes=await hashPage(index);
          if(hashes[String(index)]!==digest) throw new Error('文件内容与已上传分片不同。请清空列表，勾选“创建全新任务”后重新选择文件。');
        } else {
          await api(`/api/uploads/${info.id}/chunks/${index}`,{method:'PUT',body:data,headers:{'Content-Type':'application/octet-stream','X-Chunk-SHA256':digest},signal,attempts:6});
          job.done+=chunk.size;job.transferred+=chunk.size;
        }
        recordPhaseProgress(job,chunk.size);
        checked++;
        job.message=name==='verifying'?`校验 ${checked.toLocaleString()} / ${totalChunks.toLocaleString()} 片`:`${(100*job.done/Math.max(1,job.file.size)).toFixed(1)}% · 上传中`;
        paintJob(job);
        // Release the event loop for HTTP origins using the SHA fallback.
        if(checked%8===0) await delay(0,signal);
      }
    };
    let firstError;
    const workers=Array.from({length:Number($('concurrency').value)},()=>worker().catch(error=>{
      if(!firstError){firstError=error;controller.abort();}
      throw error;
    }));
    await Promise.allSettled(workers);
    if(firstError)throw firstError;
  }
  // Measure local verification and missing-chunk uploads independently, so fast
  // resume checks never inflate the network speed or underestimate upload time.
  if(info.received_count)await runPhase('verifying',info.received_bytes,info.received_count);
  if(info.received_bytes<job.file.size)await runPhase('uploading',job.file.size-info.received_bytes,info.total-info.received_count);
  checkAbort(signal);
  job.phase='finalizing';job.message='确认全部分片，保存文件…';paintJob(job);
  const result=await api(`/api/uploads/${info.id}/complete`,{method:'POST',signal,attempts:3});
  freezeTiming(job);job.state='complete';job.done=job.file.size;job.filename=result.filename;job.message='✓ 已保存到服务器';paintJob(job);
}
async function start() {
  if(running) {paused=true;controller.abort();return;}
  if(!connected) {notice('请先连接服务器。','error');return;}
  running=true;paused=false;controller=new AbortController();updateControls();notice('');
  const paintTimer=setInterval(()=>jobs.filter(job=>job.state==='uploading').forEach(paintJob),1000);
  let current;
  try {
    // Freeze this batch. Files added while uploading remain queued for the next start.
    const batch=jobs.filter(job=>job.state!=='complete');
    for(const job of batch) {
      checkAbort(controller.signal);current=job;
      await transfer(job,controller.signal);
    }
    notice('本批文件已全部接收并保存。','success');
  } catch(error) {
    if(current)freezeTiming(current);
    if(paused) {
      if(current){current.state='paused';current.message='已暂停 · 点击继续上传';paintJob(current);}
      notice('传输已暂停。已确认的分片会被保留，可随时继续。');
    } else {
      if(current){current.state='error';current.message=error.message;paintJob(current);}
      notice(error.message+' 已确认的上传进度会保留。','error');
      paused=true;
    }
  } finally {
    clearInterval(paintTimer);
    running=false;updateControls();refreshHistory().catch(()=>{});
  }
}
async function refreshHistory(status) {
  if(!connected) return;
  const version=sessionVersion;
  const result=status || await api('/api/status');
  if(!connected || version!==sessionVersion)return;
  $('destination').textContent=result.upload_dir;
  const tbody=$('historyRows');tbody.replaceChildren();
  if(!result.uploads.length) {
    const row=tbody.insertRow(),cell=row.insertCell();cell.colSpan=4;cell.className='empty-state';cell.textContent='还没有接收记录，上传第一个文件吧。';return;
  }
  for(const record of result.uploads) {
    const row=tbody.insertRow(),name=row.insertCell(),size=row.insertCell(),state=row.insertCell(),action=row.insertCell();
    const title=document.createElement('span');title.className='record-name';title.textContent=record.name;name.append(title);
    if(record.state==='complete') {const target=document.createElement('small');target.className='record-target';target.textContent=record.filename;name.append(target);}
    size.textContent=bytes(record.size);
    const tag=document.createElement('span');tag.className='tag'+(record.state==='complete'?' success':'');tag.textContent=record.state==='complete'?'已保存':record.state==='finalizing'?'等待完成确认':'可续传';state.append(tag);
    if(record.state==='uploading') {
      const button=document.createElement('button');button.className='delete-task';button.textContent='删除任务';button.disabled=running;
      button.addEventListener('click',async()=>{
        if(!confirm(`删除“${record.name}”的未完成分片？删除后需要重新上传。`)) return;
        button.disabled=true;
        try {await api(`/api/uploads/${record.id}`,{method:'DELETE'});await refreshHistory();notice('已删除未完成任务。');}
        catch(error){notice(error.message,'error');button.disabled=false;}
      });action.append(button);
    } else action.textContent='—';
  }
}
async function connect(event, restored=null) {
  event?.preventDefault();
  if(loginBusy || running)return;
  loginBusy=true;loginController=new AbortController();updateControls();showLogin();
  $('loginButton').textContent=restored?'正在恢复登录…':'正在登录…';
  try {
    const credentials={apiBase:normalizeBackend(restored?.apiBase || $('serverUrl').value),token:(restored?.token || $('token').value).trim()};
    if(!credentials.token) throw new Error('请输入访问密钥。');
    const options={auth:credentials,signal:loginController.signal};
    const status=await api('/api/status',options);
    const config=await api('/api/config',options);
    if(typeof status.upload_dir!=='string' || !Array.isArray(status.uploads) ||
       !Number.isSafeInteger(config.chunk_size) || config.chunk_size<1 || config.chunk_size>1_000_000 ||
       !Number.isSafeInteger(config.max_file_size) || config.max_file_size<1 || config.max_file_size>50_000_000_000) {
      throw new Error('该地址不是兼容的文件接收服务，请检查服务地址。');
    }
    sessionVersion++;
    apiBase=credentials.apiBase;token=credentials.token;limits=config;connected=true;
    saveSession(credentials);$('token').value='';$('serverUrl').value=apiBase;
    $('destination').textContent=status.upload_dir;
    $('serverAddress').textContent=apiBase;
    $('connectionDot').className='tiny-dot';$('connectionText').textContent='接收端已连接';
    $('destinationBadge').className='tag success';$('destinationBadge').textContent='可上传';
    await refreshHistory(status);
    $('loginView').hidden=true;$('appView').hidden=false;notice('');
  } catch(error) {
    connected=false;token='';apiBase='';saveSession(null);
    const message=error.status===404?'未找到接收接口，请填写后端服务地址，而不是 GitHub Pages 页面地址。':
      error instanceof TypeError || error.name==='AbortError'?'无法连接接收服务，请检查 HTTPS、网络及后端 allowed_origins 配置。':error.message;
    const updatedBase=globalThis.FILE_BRIDGE_CONFIG?.apiBase;
    if(restored && updatedBase && updatedBase!==restored.apiBase && !error.status) {
      // Update the address only. Never forward a saved key to a different server.
      $('serverUrl').value=updatedBase;
      $('token').value='';
      showLogin('原接收地址已不可用，已填入更新后的地址。请重新输入访问密钥登录。');
    } else showLogin(message);
  } finally {loginBusy=false;loginController=null;$('loginButton').textContent='登录 →';updateControls();}
}
$('loginForm').addEventListener('submit',connect);
$('logoutButton').addEventListener('click',()=>{if(!running && !loginBusy)endSession();});
$('fileInput').addEventListener('change',event=>{addFiles(event.target.files);event.target.value='';});
const dropzone=$('dropzone');
dropzone.addEventListener('keydown',event=>{if(event.key==='Enter'||event.key===' '){event.preventDefault();$('fileInput').click();}});
['dragenter','dragover'].forEach(type=>dropzone.addEventListener(type,event=>{event.preventDefault();dropzone.classList.add('dragover');}));
['dragleave','drop'].forEach(type=>dropzone.addEventListener(type,event=>{event.preventDefault();dropzone.classList.remove('dragover');}));
dropzone.addEventListener('drop',event=>addFiles(event.dataTransfer.files));
window.addEventListener('dragover',event=>event.preventDefault());
window.addEventListener('drop',event=>event.preventDefault());
$('startButton').addEventListener('click',start);
$('clearButton').addEventListener('click',()=>{if(!running){jobs.length=0;paused=false;renderQueue();notice('');}});
$('refreshButton').addEventListener('click',()=>refreshHistory().catch(error=>notice(error.message,'error')));
window.addEventListener('beforeunload',event=>{if(running){event.preventDefault();event.returnValue='';}});
updateControls();
if(savedSession) {
  const restored=savedSession;
  savedSession=null;
  connect(null,restored);
}

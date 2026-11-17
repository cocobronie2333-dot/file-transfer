const vm=require('node:vm');
const fs=require('node:fs');
const path=require('node:path');
const assert=require('node:assert/strict');
class Element {
  constructor(){this.style={};this.children=[];this.value='';this.hidden=false;this.checked=false;this.classList={add(){},remove(){}};}
  addEventListener(){} setAttribute(){} append(...items){this.children.push(...items);}
  replaceChildren(){this.children=[];} insertRow(){const row=new Element();this.append(row);return row;}
  insertCell(){const cell=new Element();this.append(cell);return cell;}
}
function setup({saved,invalidKey=false,storageDisabled=false,configuredBase='',origin='https://owner.github.io',status404=false,networkFailure=false}={}) {
  const elements=new Map(),storage=new Map(),requests=[];
  if(saved)storage.set('fileBridgeSession',JSON.stringify(saved));
  const element=id=>{if(!elements.has(id))elements.set(id,new Element());return elements.get(id);};
  const mode={invalidKey,status404,networkFailure};
  const context=vm.createContext({
    document:{getElementById:element,createElement:()=>new Element(),querySelectorAll:()=>[]},
    sessionStorage:{getItem:key=>{if(storageDisabled)throw new Error('storage denied');return storage.get(key)||null;},setItem:(key,value)=>{if(storageDisabled)throw new Error('storage denied');storage.set(key,value);},removeItem:key=>storage.delete(key)},
    window:{addEventListener(){},location:new URL(origin)},FILE_BRIDGE_CONFIG:{apiBase:configuredBase},
    URL,DOMException,AbortController,setTimeout,clearTimeout,console,
    fetch:async(url,options)=>{
      requests.push({url,options});
      if(mode.networkFailure)throw new TypeError('Failed to fetch');
      assert.equal(options.credentials,'omit');assert.equal(options.redirect,'error');assert.equal(options.mode,'cors');
      if(mode.invalidKey)return {ok:false,status:401,json:async()=>({detail:'访问密钥不正确。'})};
      if(mode.status404)return {ok:false,status:404,json:async()=>({detail:'Not Found'})};
      if(url.endsWith('/api/status'))return {ok:true,json:async()=>({upload_dir:'D:/received',uploads:[]})};
      if(url.endsWith('/api/config'))return {ok:true,json:async()=>({chunk_size:1_000_000,max_file_size:50_000_000_000})};
      throw new Error('Unexpected URL: '+url);
    }
  });
  vm.runInContext(fs.readFileSync(path.join(__dirname,'../static/app.js'),'utf8'),context);
  return {context,element,storage,requests,mode};
}
const run=(test,code)=>vm.runInContext(code,test.context);
async function login(test,base='https://upload.example.com',key='test-access-key') {
  test.element('serverUrl').value=base;test.element('token').value=key;
  await run(test,'connect()');
}
async function restored(test) {await run(test,'(async()=>{while(loginBusy) await new Promise(resolve=>setTimeout(resolve,1));})()');}
(async()=>{
  const t=setup();
  assert.equal(t.element('serverUrl').value,'');
  await login(t,'https://upload.example.com/gateway/');
  assert.equal(run(t,'connected'),true);
  assert.equal(t.element('loginView').hidden,true);assert.equal(t.element('appView').hidden,false);
  assert.deepEqual(t.requests.map(r=>r.url),['https://upload.example.com/gateway/api/status','https://upload.example.com/gateway/api/config']);
  assert(t.requests.every(r=>r.options.headers.Authorization==='Bearer test-access-key'));
  assert.equal(JSON.parse(t.storage.get('fileBridgeSession')).apiBase,'https://upload.example.com/gateway');
  assert.equal(t.element('token').value,'');
  run(t,'endSession()');
  assert.equal(run(t,'connected'),false);assert.equal(run(t,'token'),'');
  assert.equal(t.storage.has('fileBridgeSession'),false);assert.equal(t.element('appView').hidden,true);

  const invalid=setup({invalidKey:true});await login(invalid);
  assert.equal(run(invalid,'connected'),false);assert.equal(invalid.element('loginError').hidden,false);
  assert.equal(invalid.storage.size,0);
  const insecure=setup();await login(insecure,'http://192.168.1.2:8080');
  assert.equal(insecure.requests.length,0);assert.match(insecure.element('loginError').textContent,/HTTPS/);
  for(const url of ['javascript:alert(1)','https://user:pass@example.com','https://example.com/?token=x','https://example.com/#x']) {
    await login(insecure,url);assert.equal(insecure.requests.length,0);
  }
  const local=setup({origin:'http://127.0.0.1:8080'});
  assert.equal(local.element('serverUrl').value,'http://127.0.0.1:8080');
  await login(local,'http://127.0.0.1:8080');assert.equal(run(local,'connected'),true);
  const session={apiBase:'https://original.example.com',token:'saved-key'};
  const restore=setup({saved:session,configuredBase:'https://different.example.com'});await restored(restore);
  assert.equal(run(restore,'connected'),true);
  assert(restore.requests.every(r=>r.url.startsWith(session.apiBase+'/api/')));
  assert(restore.requests.every(r=>r.options.headers.Authorization==='Bearer saved-key'));
  const expired=setup({saved:session,invalidKey:true});await restored(expired);
  assert.equal(run(expired,'connected'),false);assert.equal(expired.storage.size,0);
  const replaced=setup({saved:session,configuredBase:'https://replacement.example.com',networkFailure:true});await restored(replaced);
  assert.equal(replaced.element('serverUrl').value,'https://replacement.example.com');
  assert.equal(replaced.element('token').value,'');assert.equal(replaced.storage.size,0);
  assert(replaced.requests.every(r=>r.url.startsWith(session.apiBase+'/api/')));
  assert.match(replaced.element('loginError').textContent,/重新输入/);
  const revoked=setup();await login(revoked);revoked.mode.invalidKey=true;
  await assert.rejects(()=>run(revoked,"api('/api/status')"));
  assert.equal(run(revoked,'connected'),false);assert.equal(revoked.storage.size,0);
  assert.equal(revoked.element('appView').hidden,true);
  const noStorage=setup({storageDisabled:true});await login(noStorage);
  assert.equal(run(noStorage,'connected'),true);
  const wrongServer=setup({status404:true});await login(wrongServer);
  assert.match(wrongServer.element('loginError').textContent,/后端服务地址/);
  console.log('Login: routing, backend prefix, logout, bad key, URL validation, HTTPS, local mode, bound session restore, expiry, revocation, storage fallback, wrong server passed.');
})().catch(error=>{console.error(error);process.exitCode=1;});

// Exercise the actual browser transfer code with an in-memory API and DOM stubs.
// No browser or third-party test runtime is required.
const vm=require('node:vm');
const fs=require('node:fs');
const path=require('node:path');
const assert=require('node:assert/strict');
const {webcrypto,createHash,randomBytes}=require('node:crypto');
const digest=data=>createHash('sha256').update(data).digest('hex');
class Element {
  constructor(){this.style={};this.children=[];this.value='';this.checked=false;this.classList={add(){},remove(){}};}
  addEventListener(){} setAttribute(){} append(...items){this.children.push(...items);}
  replaceChildren(){this.children=[];} insertRow(){const row=new Element();this.append(row);return row;}
  insertCell(){const cell=new Element();this.append(cell);return cell;}
}
async function scenario({resumed=[],conflict=false,empty=false,transient=false}={}) {
  const elements=new Map();
  const element=id=>{if(!elements.has(id))elements.set(id,new Element());return elements.get(id);};
  element('concurrency').value='4';
  const data=empty?Buffer.alloc(0):randomBytes(3_000_117);
  const chunks=new Map(resumed.map(i=>[i,Buffer.from(data.subarray(i*1_000_000,(i+1)*1_000_000))]));
  if(conflict) chunks.get(resumed[0])[100]^=1;
  const requests=[];let failed=false,complete=false;
  const context=vm.createContext({
    document:{getElementById:element,createElement:()=>new Element(),querySelectorAll:()=>[]},
    sessionStorage:{getItem:()=>null,setItem(){},removeItem(){}},window:{addEventListener(){},location:{hostname:'localhost',origin:'http://localhost',protocol:'http:'}},
    URL,
    crypto:webcrypto,TextEncoder,Uint8Array,Uint32Array,DataView,ArrayBuffer,DOMException,AbortController,
    performance,setTimeout,clearTimeout,atob,btoa,console,
    fetch:async(url,options)=>{
      assert.equal(new URL(url).origin,'https://upload.example.com');
      assert.equal(options.headers.Authorization,'Bearer upload-test-key');
      url=new URL(url).pathname+new URL(url).search;
      const respond=result=>({ok:true,json:async()=>result});
      if(url==='/api/uploads') {
        const bitmap=Buffer.alloc(Math.ceil(Math.ceil(data.length/1_000_000)/8));
        for(const i of chunks.keys())bitmap[i>>3]|=1<<(i%8);
        return respond({id:'test-task',chunk_size:1_000_000,total:Math.ceil(data.length/1_000_000),bitmap:bitmap.toString('base64'),received_count:chunks.size,received_bytes:[...chunks.values()].reduce((s,b)=>s+b.length,0)});
      }
      if(url.includes('/hashes?'))return respond(Object.fromEntries([...chunks].map(([i,b])=>[i,digest(b)])));
      if(url.includes('/chunks/')) {
        const i=Number(url.split('/').pop()),body=Buffer.from(options.body);
        if(transient && !failed){failed=true;throw new TypeError('temporary offline');}
        assert(body.length<=1_000_000);
        assert.equal(digest(body),options.headers['X-Chunk-SHA256']);
        requests.push({i,length:body.length});chunks.set(i,body);return respond({ok:true});
      }
      if(url.endsWith('/complete')) {
        assert.equal(Buffer.concat([...chunks].sort((a,b)=>a[0]-b[0]).map(x=>x[1])).compare(data),0);
        complete=true;return respond({filename:'received.bin',state:'complete'});
      }
      if(url==='/api/status')return respond({upload_dir:'D:/test',uploads:[]});
      throw new Error('Unexpected URL: '+url);
    }
  });
  for(const file of ['sha256.js','app.js'])vm.runInContext(fs.readFileSync(path.join(__dirname,'../static',file),'utf8'),context);
  context.testFile=new File([data],'sample.bin',{lastModified:123456789});
  await vm.runInContext('connected=true; apiBase="https://upload.example.com"; token="upload-test-key"; addFiles([testFile]); start()',context);
  const state=vm.runInContext('jobs[0].state',context);
  if(conflict){assert.equal(state,'error');assert.equal(complete,false);}
  else {assert.equal(state,'complete');assert.equal(complete,true);assert.equal(requests.length,Math.ceil(data.length/1_000_000)-resumed.length);}
  return requests;
}
(async()=>{
  const fresh=await scenario();assert.deepEqual(fresh.map(r=>r.length).sort((a,b)=>a-b),[117,1_000_000,1_000_000,1_000_000]);
  const resumed=await scenario({resumed:[0,2]});assert.deepEqual(resumed.map(r=>r.i).sort(),[1,3]);
  await scenario({resumed:[0],conflict:true});
  await scenario({empty:true});
  await scenario({transient:true});
  console.log('Frontend transfer: fresh upload, verified resume, conflict, empty file, retry passed.');
})().catch(error=>{console.error(error);process.exitCode=1;});

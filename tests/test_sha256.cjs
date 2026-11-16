const {readFileSync}=require('node:fs');
const {runInThisContext}=require('node:vm');
const {createHash,randomBytes}=require('node:crypto');
const assert=require('node:assert/strict');
const path=require('node:path');
runInThisContext(readFileSync(path.join(__dirname,'../static/sha256.js'),'utf8'));
for(const n of [0,1,3,55,56,63,64,65,127,128,1000000]) {
  const data=randomBytes(n);
  assert.equal(sha256Fallback(data),createHash('sha256').update(data).digest('hex'),`length ${n}`);
}
assert.equal(sha256Fallback(Buffer.from('abc')),'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
console.log('SHA-256 fallback: 12 vectors passed, including 1,000,000-byte input.');

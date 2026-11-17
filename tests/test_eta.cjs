const vm=require('node:vm');
const fs=require('node:fs');
const path=require('node:path');
const assert=require('node:assert/strict');
const elements=new Map();
const element=id=>{
  if(!elements.has(id))elements.set(id,{value:'',addEventListener(){},classList:{add(){},remove(){}}});
  return elements.get(id);
};
let now=0;
const context=vm.createContext({
  document:{getElementById:element,querySelectorAll:()=>[]},
  sessionStorage:{getItem:()=>null},window:{location:new URL('http://localhost'),addEventListener(){}},
  URL,performance:{now:()=>now}
});
vm.runInContext(fs.readFileSync(path.join(__dirname,'../static/app.js'),'utf8'),context);
const run=code=>vm.runInContext(code,context);
assert.equal(run('formatDuration(0.1)'),'少于1秒');
assert.equal(run('formatDuration(61.2)'),'1分2秒');
assert.equal(run('formatDuration(3661)'),'1小时1分');
assert.equal(run('formatDuration(93600)'),'1天2小时');
assert.equal(run('formatDuration(Infinity)'),'计算中');
assert.equal(run('formatDuration(-1)'),'计算中');

// Known throughput: 2MB acknowledged in 2s leaves 48s for a 50MB upload.
run('var job={state:"uploading",activeSince:0}; beginPhase(job,"uploading",50_000_000)');
assert.match(run('timingText(job)'),/计算中/);
now=1000;run('recordPhaseProgress(job,1_000_000)');
assert.equal(run('phaseRate(job)'),null);
now=2000;run('recordPhaseProgress(job,1_000_000)');
assert.equal(run('phaseRate(job)'),1_000_000);
assert.match(run('timingText(job)'),/预计上传剩余：约 48秒/);

// Long files use day/hour formatting, never Infinity or negative estimates.
run('job.timingPhase.total=50_000_000_000');
assert.match(run('timingText(job)'),/13小时/);
assert.doesNotMatch(run('timingText(job)'),/Infinity|NaN|-/);

// A 15-second rolling window follows slowing acknowledgements.
now=16000;run('recordPhaseProgress(job,1_000_000)');
assert.equal(run('phaseRate(job)'),2_000_000/15);
now=32001;assert.equal(run('phaseRate(job)'),null);
assert.match(run('timingText(job)'),/计算中/);

// Pause freezes elapsed time; resuming excludes paused time and resets the rate.
run('freezeTiming(job); job.state="paused"');
const elapsed=run('elapsedSeconds(job)');
now=3600000;assert.equal(run('elapsedSeconds(job)'),elapsed);
assert.match(run('timingText(job)'),/已暂停/);
run('job.state="uploading"; job.activeSince=performance.now(); beginPhase(job,"uploading",5_000_000)');
assert.equal(run('phaseRate(job)'),null);
now+=2000;run('recordPhaseProgress(job,1_000_000)');
assert.match(run('timingText(job)'),/预计上传剩余：约 8秒/);
assert.equal(run('elapsedSeconds(job)'),elapsed+2);

// Local resume verification must not inflate the following upload rate.
run('beginPhase(job,"verifying",100_000_000)');
now+=2000;run('recordPhaseProgress(job,50_000_000)');
assert.match(run('timingText(job)'),/预计校验剩余：约 2秒/);
run('beginPhase(job,"uploading",10_000_000)');
assert.match(run('timingText(job)'),/预计上传剩余：计算中/);
now+=2000;run('recordPhaseProgress(job,1_000_000)');
assert.equal(run('phaseRate(job)'),500_000);
assert.match(run('timingText(job)'),/预计上传剩余：约 18秒/);

run('job.phase="finalizing"');
assert.match(run('timingText(job)'),/正在保存文件/);
assert.doesNotMatch(run('timingText(job)'),/预计/);
run('freezeTiming(job); job.state="complete"');
const completed=run('timingText(job)');now+=60000;
assert.equal(run('timingText(job)'),completed);
assert.doesNotMatch(completed,/剩余/);
assert.match(run('timingText({state:"waiting"})'),/开始传输后估算/);
console.log('ETA: warm-up, known speed, 50GB duration, rolling slowdown, stalled network, pause/resume, verification, finalizing and frozen completion passed.');

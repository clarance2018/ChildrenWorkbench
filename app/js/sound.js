/* ========== 音效与动效（WebAudio 合成，无需音频素材） ========== */
const Sound = {
  ctx:null,
  enabled(){ return !Store.db || Store.db.settings.sound!==false; },
  _ctx(){
    if(!this.ctx){ const AC=window.AudioContext||window.webkitAudioContext; if(!AC) return null; this.ctx=new AC(); }
    if(this.ctx.state==="suspended") this.ctx.resume();
    return this.ctx;
  },
  tone(freq, dur, type, gain, delay){
    if(!this.enabled()) return;
    const ctx=this._ctx(); if(!ctx) return;
    const t0=ctx.currentTime+(delay||0);
    const osc=ctx.createOscillator(), g=ctx.createGain();
    osc.type=type||"sine"; osc.frequency.setValueAtTime(freq,t0);
    g.gain.setValueAtTime(0,t0);
    g.gain.linearRampToValueAtTime(gain||0.16,t0+0.02);
    g.gain.exponentialRampToValueAtTime(0.001,t0+(dur||0.15));
    osc.connect(g).connect(ctx.destination);
    osc.start(t0); osc.stop(t0+(dur||0.15)+0.02);
  },
  pop(){ this.tone(760,0.08,"square",0.07); },
  complete(){ [523.25,659.25,783.99].forEach((f,i)=>this.tone(f,0.18,"sine",0.18,i*0.085)); },
  star(){ [1046.5,1318.5].forEach((f,i)=>this.tone(f,0.12,"triangle",0.12,i*0.06)); },
  overtime(){ [660,523,415].forEach((f,i)=>this.tone(f,0.24,"triangle",0.2,i*0.2)); },
  reject(){ [392,311].forEach((f,i)=>this.tone(f,0.22,"sine",0.14,i*0.16)); },
  tickWarn(){ this.tone(880,0.07,"sine",0.09); },
  /* 提醒铃：上行三音重复两次，比单音更容易被注意到 */
  reminder(){
    const seq=[880,1046.5,1318.5];
    seq.forEach((f,i)=>this.tone(f,0.14,"sine",0.16,i*0.12));
    seq.forEach((f,i)=>this.tone(f,0.14,"sine",0.13,0.5+i*0.12));
  },
  /* 全部完成：上行琶音 + 高音收尾 */
  celebrate(){
    [523.25,659.25,783.99,1046.5].forEach((f,i)=>this.tone(f,0.2,"triangle",0.18,i*0.11));
    this.tone(1318.5,0.42,"sine",0.16,0.52);
  },
  /* 家长语音鼓励前的引导音：温暖三连上行，提示"有悄悄话" */
  encourage(){
    [587.33,739.99,880].forEach((f,i)=>this.tone(f,0.18,"sine",0.14,i*0.1));
    this.tone(1174.66,0.26,"sine",0.1,0.34);
  },
  /* 护眼休息：轻柔两连降，提示该歇一歇眼睛 */
  eyeRest(){
    [783.99,622.25,783.99].forEach((f,i)=>this.tone(f,0.22,"sine",0.13,i*0.22));
  }
};

/* 完成时的星星迸发动画 */
function starBurst(count){
  const n=count||6;
  const box=document.createElement("div");
  box.className="star-burst";
  for(let i=0;i<n;i++){
    const s=document.createElement("span");
    s.textContent="⭐";
    s.style.setProperty("--dx",(Math.random()*2-1)*160+"px");
    s.style.setProperty("--dy",(-60-Math.random()*140)+"px");
    s.style.setProperty("--rot",(Math.random()*180-90)+"deg");
    s.style.animationDelay=(i*40)+"ms";
    box.appendChild(s);
  }
  document.body.appendChild(box);
  setTimeout(()=>box.remove(),1400);
}

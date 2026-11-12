/* ========== 前端会话：服务端登录 / 孩子平板配对 / 会话管理 ==========
 * 后端在线时一律走服务端会话（HttpOnly Cookie），前端不再自己比对 PIN。
 * 后端不在线（纯本地模式）时保留旧的本地 PIN 流程，功能不中断。
 */
const Auth = {
  required:false,      // 是否启用了服务端鉴权
  scope:null,          // "parent" | "child" | "local"
  label:"",
  secure:false,
  info:null,
  error:null,
  busy:false,

  async init(){
    try{
      const me = await fetch("/api/auth/me",{cache:"no-store"}).then(r=>r.json());
      if(me && me.ok){
        this.required=true; this.scope=me.scope; this.label=me.label||""; this.secure=!!me.secure;
        this.sessionId=me.session_id||""; return this;
      }
      if(me && me.auth_required){
        this.required=true; this.scope=null; this.secure=!!me.secure; return this;
      }
    }catch(e){ /* 无后端 */ }
    this.required=false; this.scope="local";
    return this;
  },

  canParent(){ return !this.required || this.scope==="parent"; },
  canChild(){ return !this.required || this.scope==="parent" || this.scope==="child"; },
  isChildDevice(){ return this.required && this.scope==="child"; },

  async login(pin){
    this.busy=true; this.error=null;
    try{
      const r=await fetch("/api/auth/pin",{method:"POST",headers:{"Content-Type":"application/json"},
        body:JSON.stringify({pin})}).then(x=>x.json());
      if(r.ok){ this.scope="parent"; await Store.resume(); this.busy=false; return {ok:true}; }
      this.error=r.message||"PIN 不正确"; this.busy=false; return {ok:false, message:this.error};
    }catch(e){ this.busy=false; this.error="无法连接服务端"; return {ok:false,message:this.error}; }
  },

  async pair(code,label){
    this.busy=true; this.error=null;
    try{
      const r=await fetch("/api/auth/pair",{method:"POST",headers:{"Content-Type":"application/json"},
        body:JSON.stringify({code,label:label||"孩子平板"})}).then(x=>x.json());
      if(r.ok){ this.scope="child"; this.label=r.label; await Store.resume(); this.busy=false; return {ok:true}; }
      this.error=r.message||"配对失败"; this.busy=false; return {ok:false,message:this.error};
    }catch(e){ this.busy=false; this.error="无法连接服务端"; return {ok:false,message:this.error}; }
  },

  async logout(){
    try{ await fetch("/api/auth/logout",{method:"POST"}); }catch(e){}
    this.scope=null;
    location.hash="#/";
    location.reload();
  },

  /* ---------- 界面 ---------- */
  renderLogin(target){
    const lan = (Store.info && Store.info.lan) || [];
    const host = (typeof location!=="undefined" && location.hostname) || "";
    const httpsUrls = (lan.length ? lan.map(ip=>`https://${ip}:8443`) : (host?[`https://${host}:8443`]:[]));
    return `<div class="pin-wrap"><div class="pin-card">
      <div style="font-size:34px">🔐</div>
      <h2 class="mt8">家长登录</h2>
      <div class="small muted mt8">输入 PIN 码进入家长后台。验证由服务端完成，Cookie 为 HttpOnly，孩子端无法读取。</div>
      <input id="pin-input" type="password" inputmode="numeric" maxlength="8" autocomplete="off" placeholder="••••">
      <div id="pin-err" class="small" style="color:#d64545;min-height:18px">${this.error?esc(this.error):""}</div>
      <div class="flex" style="justify-content:center;gap:10px">
        <button class="btn btn-primary" onclick="Auth.submitLogin()">进入</button>
        <button class="btn btn-ghost" onclick="location.hash='#/'">返回</button>
        ${target==="child"?`<button class="btn btn-ghost" onclick="location.hash='#/pair'">这是孩子平板</button>`:""}
      </div>
      <div class="small muted mt16">默认 PIN：1234（登录后可在设置中修改）</div>
      ${httpsUrls.length?`<div class="small muted mt8" style="line-height:1.6">平板访问地址（需信任自签名证书）：<br>${httpsUrls.map(u=>`<code>${esc(u)}</code>`).join("<br>")}</div>`:""}
    </div></div>`;
  },

  async submitLogin(){
    const el=document.getElementById("pin-input"); if(!el) return;
    const val=(el.value||"").trim();
    if(!val) return;
    const r=await this.login(val);
    if(r.ok){ Sound.pop(); location.reload(); }
    else{
      el.value=""; Sound.overtime();
      const e=document.getElementById("pin-err"); if(e) e.textContent=r.message;
    }
  },

  renderPair(){
    return `<div class="pin-wrap"><div class="pin-card">
      <div style="font-size:34px">📱</div>
      <h2 class="mt8">配对孩子平板</h2>
      <div class="small muted mt8">在家长后台「设置 → 设备」点击「生成配对码」，把 6 位数字填到这里。配对后这台平板一年内无需重复登录，且只有孩子端权限。</div>
      <input id="pair-input" type="tel" inputmode="numeric" maxlength="6" autocomplete="off" placeholder="6 位配对码">
      <input id="pair-label" maxlength="16" placeholder="设备名，如：客厅平板" style="margin-top:8px">
      <div id="pin-err" class="small" style="color:#d64545;min-height:18px">${this.error?esc(this.error):""}</div>
      <div class="flex" style="justify-content:center;gap:10px">
        <button class="btn btn-primary" onclick="Auth.submitPair()">配对</button>
        <button class="btn btn-ghost" onclick="location.hash='#/'">返回</button>
      </div>
    </div></div>`;
  },

  async submitPair(){
    const code=(document.getElementById("pair-input").value||"").trim();
    const label=(document.getElementById("pair-label").value||"").trim();
    if(code.length!==6) { toast("请输入 6 位配对码"); return; }
    const r=await this.pair(code,label);
    if(r.ok){ Sound.pop(); location.hash="#/child"; location.reload(); }
    else{
      Sound.overtime();
      const e=document.getElementById("pin-err"); if(e) e.textContent=r.message;
    }
  },

  renderChildOnly(){
    return `<div class="pin-wrap"><div class="pin-card">
      <div style="font-size:34px">🧒</div>
      <h2 class="mt8">这台设备是孩子端</h2>
      <div class="small muted mt8">孩子设备不开放家长后台。请用家长手机或电脑访问同一地址并输入 PIN。</div>
      <div class="flex" style="justify-content:center;gap:10px;margin-top:16px">
        <button class="btn btn-primary" onclick="location.hash='#/child'">回到今日任务</button>
      </div>
    </div></div>`;
  },

  /* ---------- 家长设置页：设备与会话 ---------- */
  async renderDeviceCard(){
    let sessions=[];
    try{ sessions=(await fetch("/api/auth/sessions").then(x=>x.json())).sessions||[]; }catch(e){}
    const cur=(Auth.sessionId||"");
    const rows=sessions.map(s=>`<tr>
      <td>${s.scope==="parent"?"👨‍👩‍👧 家长":"🧒 孩子"}<div class="small muted">${esc(s.label||"")}</div></td>
      <td class="small">${esc(fmtTime(s.last_seen))}</td>
      <td class="small">${esc(fmtDateOf(s.expires_at))}</td>
      <td>${s.id===cur?`<span class="tag tag-green">当前</span>`:`<button class="btn btn-red btn-sm" onclick="Auth.revokeSession('${s.id}')">退出</button>`}</td>
    </tr>`).join("");
    return `<div class="card"><h3>设备与登录</h3>
      <div class="small muted">家长会话 30 天，孩子平板 365 天。删除会话即让该设备立即失效。</div>
      <div class="flex mt12" style="gap:8px;flex-wrap:wrap">
        <button class="btn btn-primary btn-sm" onclick="Auth.makePairing()">生成配对码</button>
        <button class="btn btn-ghost btn-sm" onclick="Auth.logout()">退出登录</button>
      </div>
      <div id="pair-box" class="mt12"></div>
      <table class="grid mt12"><thead><tr><th>设备</th><th>最近使用</th><th>到期</th><th></th></tr></thead>
      <tbody>${rows||`<tr><td colspan="4"><div class="empty-tip">暂无记录</div></td></tr>`}</tbody></table>
    </div>`;
  },

  async makePairing(){
    if(!Parent.isAdmin()) return;
    try{
      const r=await fetch("/api/auth/pairing",{method:"POST",headers:{"Content-Type":"application/json"},body:"{}"}).then(x=>x.json());
      if(!r.ok) return toast(r.message||"生成失败");
      const box=document.getElementById("pair-box");
      if(box) box.innerHTML=`<div class="card" style="background:#fff8e6;border:1px solid #f0d79a">
        <div class="small muted">在孩子的平板上打开 <code>https://${(Store.info&&Store.info.lan&&Store.info.lan[0])||"本机IP"}:8443/#/pair</code>，输入：</div>
        <div style="font-size:34px;letter-spacing:8px;font-weight:700;margin:8px 0">${r.code}</div>
        <div class="small muted">10 分钟内有效，仅可使用一次。</div></div>`;
    }catch(e){ toast("无法连接服务端"); }
  },

  revokeSession(id){
    confirmModal("退出该设备", "该设备会立即失去访问权限，需要重新登录或配对。", async ()=>{
      await fetch("/api/auth/sessions/"+id,{method:"DELETE"});
      toast("已退出"); route();
    });
  },

  async changePin(oldPin,newPin){
    try{
      const r=await fetch("/api/auth/pin/change",{method:"POST",headers:{"Content-Type":"application/json"},
        body:JSON.stringify({oldPin,newPin})}).then(x=>x.json());
      toast(r.ok? "PIN 已更新（其他设备已退出）" : (r.message||"修改失败"));
      return r;
    }catch(e){ toast("无法连接服务端"); return {ok:false}; }
  }
};

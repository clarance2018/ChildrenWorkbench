/* ========== 入口：路由 + 会话校验 + 同步轮询 + 通用组件 ========== */
let PIN_OK = sessionStorage.getItem("hw_pin_ok") === "1";

function isEditing(){
  const el=document.activeElement;
  return el && ["INPUT","TEXTAREA","SELECT"].includes(el.tagName);
}

function route(){
  const hash = location.hash || "#/";
  const app = document.getElementById("app");
  const parts = hash.replace(/^#\//,"").split("/").filter(Boolean);

  /* 服务端鉴权开启时：未登录先登录（家长/孩子路由都需要会话） */
  if(Auth.required && !Auth.scope){
    if(parts[0]==="parent"||parts[0]==="child"){ app.innerHTML = Auth.renderLogin(parts[0]); focusPin(); return; }
    if(parts[0]==="pair"){ app.innerHTML = Auth.renderPair(); focusPair(); return; }
    app.innerHTML = renderPortal(); return;
  }
  /* 孩子平板不能进家长后台 */
  if(Auth.isChildDevice() && parts[0]==="parent"){ app.innerHTML = Auth.renderChildOnly(); return; }
  if(parts[0]==="pair"){ app.innerHTML = Auth.renderPair(); focusPair(); return; }
  /* 纯本地模式：沿用浏览器内 PIN（无后端时） */
  if(!Auth.required && parts[0]==="parent" && !PIN_OK){ app.innerHTML = renderPin(); focusPin(); return; }

  if(parts[0]==="parent"){
    app.innerHTML = Parent.render(parts[1]);
    window.scrollTo(0,0);
    if(parts[1]==="settings" && typeof Parent.mountSettings==="function") Parent.mountSettings();
    return;
  }
  if(parts[0]==="child"){
    app.innerHTML = Child.render(parts[1], parts[2]); window.scrollTo(0,0);
    if(parts[1]==="task") Child.tick();
    return;
  }
  app.innerHTML = renderPortal();
}

/* ---------- 本地模式 PIN（无后端时） ---------- */
function renderPin(){
  return `<div class="pin-wrap"><div class="pin-card">
    <div style="font-size:34px">🔒</div>
    <h2 class="mt8">家长验证</h2>
    <div class="small muted mt8">当前为本地模式（未连接后端），请输入 4 位 PIN</div>
    <input id="pin-input" type="password" inputmode="numeric" maxlength="4" autocomplete="off" placeholder="••••">
    <div class="flex" style="justify-content:center;gap:10px">
      <button class="btn btn-primary" onclick="submitPin()">进入</button>
      <button class="btn btn-ghost" onclick="location.hash='#/'">返回</button>
    </div>
    <div class="small muted mt16">默认 PIN：1234</div>
  </div></div>`;
}
function focusPin(){
  const el=document.getElementById("pin-input"); if(!el) return;
  el.focus();
  el.addEventListener("keydown", e=>{ if(e.key==="Enter") submitPin(); });
  if(!Auth.required){
    el.addEventListener("input", ()=>{ if(el.value.length===4) submitPin(); });
  }
}
function focusPair(){
  const el=document.getElementById("pair-input"); if(!el) return;
  el.focus();
  el.addEventListener("input", ()=>{ if(el.value.length===6) Auth.submitPair(); });
  el.addEventListener("keydown", e=>{ if(e.key==="Enter") Auth.submitPair(); });
}
async function submitPin(){
  const el=document.getElementById("pin-input"); if(!el) return;
  const val=(el.value||"").trim(); if(!val) return;
  if(Auth.required){
    const r=await Auth.login(val);
    if(r.ok){ Sound.pop(); location.reload(); }
    else{
      el.value=""; Sound.overtime();
      const e=document.getElementById("pin-err"); if(e) e.textContent=r.message;
    }
    return;
  }
  if(val === String(Store.db.settings.parent_pin||"1234")){
    PIN_OK=true; sessionStorage.setItem("hw_pin_ok","1"); Sound.pop(); route();
  }else{
    el.value=""; Sound.overtime(); toast("PIN 码不正确");
  }
}

function renderPortal(){
  const lan=(Store.info&&Store.info.lan)||[];
  const httpsUrls=lan.map(ip=>`https://${ip}:8443`);
  const authLine = Auth.required
    ? (Auth.scope==="parent" ? `已登录：家长设备（${esc(Auth.label||"本机")}）` : (Auth.scope==="child"?"已配对：孩子平板":"未登录，进入需 PIN"))
    : "本地模式（未连接后端）";
  return `<div class="portal">
    <h1>📚 儿童作业与习惯工作台</h1>
    <div class="muted">家长后台（Web）+ 孩子端（Android 平板）· ${Store.remote?"已连接后端，双端自动同步":"本地模式"} · ${esc(authLine)}</div>
    <div class="portal-cards">
      <div class="portal-card" onclick="location.hash='#/parent'">
        <div class="icon">👨‍👩‍👧</div><h2>家长后台</h2>
        <div class="muted small">发布/导入作业 · 周期与习惯 · 课表 · 复核退回 · 激励与注音设置（需 PIN）</div>
      </div>
      <div class="portal-card" onclick="location.hash='#/child'">
        <div class="icon">🧒</div><h2>孩子端（平板）</h2>
        <div class="muted small">作业与任务分开呈现 · 计时/录音 · 完成得星 · 徽章与连续天数</div>
      </div>
    </div>
    <div class="small muted">${Store.remote?"数据由本地后端统一存储，家长端与孩子端自动同步":"未检测到后端服务，数据暂存本机浏览器"}</div>
    ${httpsUrls.length?`<div class="small muted mt8">平板访问地址（首次需信任自签名证书）：${httpsUrls.map(u=>`<code>${esc(u)}</code>`).join(" · ")}</div>`:""}
    <div class="small muted mt8">
      <a href="#/pair">配对孩子平板</a>
      ${Auth.required&&Auth.scope?` · <a href="javascript:Auth.logout()">退出登录</a>`:""}
    </div>
  </div>`;
}

/* ---------- Toast（支持操作按钮） ---------- */
function toast(msg, action, duration){
  const root=document.getElementById("toast-root");
  const el=document.createElement("div"); el.className="toast";
  el.innerHTML=`<span>${msg}</span>`;
  let timer;
  if(action){
    const b=document.createElement("button");
    b.textContent=action.label;
    b.onclick=()=>{ clearTimeout(timer); action.fn(); el.remove(); };
    el.appendChild(b);
  }
  root.appendChild(el);
  timer=setTimeout(()=>el.remove(), duration||3000);
}

/* ---------- Modal ---------- */
function modal(title, bodyHtml, actions, formBody){
  const root=document.getElementById("modal-root");
  root.innerHTML=`<div class="mask" onclick="if(event.target===this)closeModal()">
    <div class="modal" style="${formBody?"max-width:560px":""}">
      <h3>${title}</h3><div class="modal-body">${bodyHtml}</div><div class="modal-actions"></div>
    </div></div>`;
  const bar=root.querySelector(".modal-actions");
  (actions||[{label:"知道了",cls:"btn-primary",fn:null}]).forEach(a=>{
    const b=document.createElement("button");
    b.className="btn "+(a.cls||"btn-ghost"); b.textContent=a.label;
    b.onclick=()=>{ if(a.fn){ const r=a.fn(); if(r===false) return; } closeModal(); };
    bar.appendChild(b);
  });
}
function closeModal(){ document.getElementById("modal-root").innerHTML=""; }
function confirmModal(title, text, onOk){
  modal(title,text,[{label:"取消",cls:"btn-ghost",fn:null},{label:"确定",cls:"btn-red",fn:onOk}]);
}

/* ---------- 启动 ---------- */
(async function boot(){
  await Auth.init();
  await Store.init();
  Store.onAuthLost = ()=>{ toast("登录已失效，请重新验证"); setTimeout(()=>location.reload(), 800); };
  // 另一端修改后自动刷新（正在录音/填写表单时不打断）
  Store.onRemoteSync = ()=>{
    if(document.querySelector("#modal-root .mask")) return;
    if(isEditing()) return;
    if((location.hash||"").startsWith("#/child/task")) return;
    route();
  };
  window.addEventListener("hashchange", route);
  route();
  setInterval(()=>Store.sync(), 3000);
  /* 提醒调度：到点播报 / 系统通知 / 家长汇总 */
  Remind.init();
  Remind.resumeKiosk();
  document.addEventListener("visibilitychange", ()=>{
    if(!document.hidden){ if(Child.rt.timer) Child.tick(); Store.sync(); Remind.tick(); }
  });
  if("serviceWorker" in navigator && location.protocol!=="file:"){
    navigator.serviceWorker.register("./sw.js").catch(()=>{});
  }
})();

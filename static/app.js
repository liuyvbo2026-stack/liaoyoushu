'use strict';
const $ = s => document.querySelector(s);
const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
let state, config, csrf, filter='pending', busy=false, pollTimer, search='', lastRevision=-1, retryAction=null, reviewIndex=0,  undoState=null, activeTaskId=null, browsing=false, view='prepare', editingId=null, noticeTimer=null, section='assistant', inspectorOpen=false, historyFilter='all', tableSearch='', historyIndex=0, reviewOverride=false, focusSuggestionId=null;
const editDrafts=new Map();
const statusNames={pending:'待确认',deferred:'待核实',confirmed:'已确认',rejected:'不采纳'};
const actionNames={import_tasks:'载入任务表',import_chat:'导入聊天',confirm:'确认修改',edit:'编辑建议',reject:'不采纳',defer:'暂时保留',resume:'继续核对',undo_confirm:'撤销确认',model_completed:'模型处理完成',model_failed:'模型处理失败'};
function showNotice(text,ok=false,retry=null,retryLabel='重试'){
  clearTimeout(noticeTimer);retryAction=retry;$('#notice').className=ok?'ok':'';$('#notice').hidden=false;
  $('#notice').innerHTML=`<span>${esc(text)}</span><div>${retry?`<button id="notice-retry">${esc(retryLabel)}</button>`:''}<button id="notice-close" aria-label="关闭提示">×</button></div>`;
  $('#notice-close').onclick=()=>$('#notice').hidden=true;
  if(retry)$('#notice-retry').onclick=()=>retryLabel==='重新选择文件'?retry():runAction(retry);
  if(ok)noticeTimer=setTimeout(()=>$('#notice').hidden=true,5500);
}
async function api(path,body){
  let res;
  try {res=await fetch(path,{method:body===undefined?'GET':'POST',headers:body===undefined?{}:{'Content-Type':'application/json','X-CSRF-Token':csrf},body:body===undefined?undefined:JSON.stringify(body)});}
  catch(e){throw Error('无法连接本地服务，请检查启动终端是否仍在运行，再重试。');}
  const value=await res.json();if(!res.ok)throw Error(value.error||'操作失败，请重试。');return value;
}
async function load(){
  const previousJob=state?.job,previousConfig=JSON.stringify(config);const data=await api('/api/state');state=data.state;config=data.config;csrf=data.csrf;undoState=data.undo;
  if(previousJob?.status==='running'&&state.job?.status==='completed'&&state.job.kind==='analysis'){reviewOverride=false;if(section==='assistant'&&!editingId)reviewIndex=0;}
  if(state.revision!==lastRevision||JSON.stringify(config)!==previousConfig){lastRevision=state.revision;render();if(state.job?.status==='completed'&&$('#notice').textContent.includes('正在分析'))showNotice('分析完成。请核对下面的建议，确认后才会改表。',true);}else renderConfig();
  if(state.job?.kind==='question'&&state.job.status==='completed'&&previousJob?.status==='running'){showNotice('已根据原文回答，任务表没有改变。',true);$('#conversation').open=true;$('#conversation').scrollIntoView({block:'end'});}
  clearTimeout(pollTimer);pollTimer=setTimeout(()=>load().catch(e=>showNotice(e.message,false,load)),state.job?.status==='running'?1000:5000);
}
async function runAction(fn,errorRetry=fn){
  if(busy)return;busy=true;renderControls();
  try{const result=await fn();if(result?.message)showNotice(result.message,true);await load();if(result?.message?.includes('修改已确认'))$('.chat-scroll').scrollTop=0;if(result?.message?.includes('结合原文回答')){$('#conversation').open=true;$('#conversation').scrollIntoView({block:'end'});}}
  catch(e){showNotice(e.message,false,errorRetry,errorRetry===fn?'重试':'重新选择文件');}
  finally{busy=false;renderControls();}
}
const locked=()=>busy||state?.job?.status==='running';
function renderConfig(){
  $('#test-banner').hidden=!config.test_label;
  $('#test-banner').textContent=config.test_label?'验收工作区':'';
  $('#test-banner').title=config.test_label||'';
}
function render(){
  renderConfig();
  const pending=state.suggestions.filter(p=>p.status==='pending').length;
  const pendingRecords=Object.values(state.records).filter(r=>r.status==='pending').length;
  const analyzed=state.runs.some(r=>r.kind==='analysis'&&r.status==='completed')||state.suggestions.length>0;
  // Explicitly opening saved suggestions must remain possible after a new upload.
  view=browsing&&section==='history'?'review':state.job?.status==='running'&&state.job.kind==='analysis'?'processing':reviewOverride&&pending?'review':!state.tasks.length||pendingRecords||!analyzed?'prepare':pending?'review':'done';
  document.body.dataset.view=view;
  $('#save-info').textContent=editDrafts.size?'建议有未保存的编辑':'已自动保存';$('#save-info').title='保存于 '+new Date(state.saved_at).toLocaleString('zh-CN');
  $('#mobile-count').textContent=state.tasks.length;
  renderUploads();renderJourney(pending,pendingRecords,analyzed);
  const ready=state.tasks.length&&pendingRecords;
  $('#analysis-action').hidden=state.job?.status==='failed'&&state.job.kind==='analysis';
  $('#analysis-action').innerHTML=ready?`<p>${pendingRecords} 条新记录待分析${config.configured?'':' · 请先连接模型'}</p><button class="primary" id="analyze">${config.configured?'开始分析 →':'配置模型连接'}</button>`:`<p>${!state.tasks.length?'先上传已有任务表。':'下一步：上传新的聊天记录。'}</p>`;
  if($('#analyze'))$('#analyze').onclick=config.configured?()=>runAction(()=>api('/api/analyze',{})):settings;
  renderJob();renderSuggestions();renderMessages();renderControls();renderUndo();renderShell();
}
function renderJourney(pending,pendingRecords,analyzed){
  const counts=Object.fromEntries(['pending','deferred','confirmed','rejected'].map(k=>[k,state.suggestions.filter(p=>p.status===k).length]));
  const step=view==='prepare'||view==='processing'?0:pending?1:2;
  document.querySelectorAll('[data-step]').forEach((el,i)=>{el.className=i===step?'active':i<step?'complete':'';if(i===step)el.setAttribute('aria-current','step');else el.removeAttribute('aria-current');el.querySelector('span').textContent=i<step?'✓':i+1;});
  $('.materials').hidden=view!=='prepare';$('#review-section').hidden=view!=='review';
  $('.right-column').hidden=!inspectorOpen;$('#export-panel').hidden=view!=='done';
  $('#restore').hidden=Boolean(state.tasks.length);$('#back-main').hidden=!browsing&&!reviewOverride;$('#back-main').textContent=browsing?'‹ 返回处理记录':'‹ 返回新材料';
  $('#pending-reminder').hidden=!(pending&&pendingRecords);$('#pending-reminder').innerHTML=pending&&pendingRecords?`<span>还有 ${pending} 条先前的建议待核对。</span><button id="review-existing" class="text-button">继续核对</button>`:'';
  if($('#review-existing'))$('#review-existing').onclick=()=>{reviewOverride=true;render();};
  $('#chat-form').hidden=!state.tasks.length||section==='history';
  let title='把聊过的事，安排明白。',description='上传任务表和聊天记录，我会帮你找出需要更新的地方。';
  if(view==='prepare'&&state.tasks.length){title=pendingRecords?'材料齐了，可以开始了':'任务表收到了';description=pendingRecords?'我会对照聊天找出变化，确认后才更新任务表。':'再上传新的聊天记录，我来帮你找出变化。';}
  if(view==='processing'){title='正在对照聊天，整理变化';description='分析完成后，我们一起核对需要更新的地方。';}
  if(view==='review'){title=browsing?filter==='deferred'?'这些事情，还需要核实':`查看${statusNames[filter]}记录`:'一起核对这些变化';description=browsing?'正在查看保存的建议与原文依据。':`发现 ${pending} 条待确认建议，逐条核对后更新任务表。`;}
  if(view==='done'){title='这次核对完成了';description=counts.deferred?`还有 ${counts.deferred} 条信息待核实，不影响先下载已确认结果。`:'已确认的修改都保存好了，可以下载，也可以继续处理新聊天。';}
  $('#next-title').textContent=title;$('#next-description').textContent=description;
  $('#progress-label').textContent=browsing?`${statusNames[filter]} · ${counts[filter]||0} 条`:`${counts.confirmed+counts.rejected} 条已处理${counts.deferred?` · ${counts.deferred} 条暂时保留`:''}`;
  $('#review-progress').innerHTML='';
  $('#export-heading').textContent='当前任务表已保存';
  $('#result-counts').textContent=`${state.tasks.length} 项任务 · 累计确认 ${counts.confirmed} 条建议${counts.rejected?` · 不采纳 ${counts.rejected} 条`:''}`;
  $('#export-note').textContent='只导出当前已确认结果，待核实内容单独保留。';
  $('#deferred-summary').innerHTML=counts.deferred?`<button id="view-deferred" class="retained-button"><span>${counts.deferred} 条信息待核实，已单独保留</span><span>查看 →</span></button>`:'';
  if($('#view-deferred'))$('#view-deferred').onclick=()=>{historyFilter='deferred';navigate('history');};
}

function renderUploads(){
  const latest=state.batches[state.batches.length-1];
  for(const [kind,title,file,count] of [['task','任务表',state.task_file,state.tasks.length],['chat','聊天记录',latest,latest?.count]]){
    $(`#${kind}-upload`).innerHTML=`<div class="upload-card ${file?'loaded':''}"><span class="file-icon" aria-hidden="true"><svg class="icon"><use href="#i-${kind==='task'?'table':'chat'}"/></svg></span><div><div class="upload-label">${title}${file?'<span class="badge success">已读取</span>':''}</div>${file?`<div class="upload-name">${esc(file.name)}</div><p>${count} ${kind==='task'?'项任务':`条记录 · 新增 ${latest.new_count} 条`}</p>`:`<p>${kind==='task'?'已有的工作安排':'本次新增的沟通内容'} · CSV 文件</p><a class="template-link" href="/api/template/${kind==='task'?'tasks':'chat'}">下载空白模板</a>`}</div><div class="upload-links">${file?`<button class="text-button" data-preview="${kind}">预览</button>`:''}<button data-upload="${kind}" aria-label="${file?(kind==='chat'?'添加聊天记录':'载入另一份任务表'):'上传'+title}" ${(!file&&(kind==='task'||state.tasks.length))?'class="primary"':''}>${file?(kind==='chat'?'添加记录':'更换'):'上传'}</button></div></div>`;
  }
  document.querySelectorAll('[data-upload]').forEach(b=>b.onclick=()=>$('#'+b.dataset.upload+'-file').click());
  document.querySelectorAll('[data-preview]').forEach(b=>b.onclick=()=>preview(b.dataset.preview));
}
function renderControls(){
  if(!state)return;
  const disabled=locked();
  document.querySelectorAll('[data-upload], [data-decision], #restore, #ask, #batch-review, #undo-last, #next-batch, #inline-save, #inline-cancel, #add-context, #add-chat, #replace-task, #add-material-chat, #add-material-context').forEach(b=>b.disabled=disabled);
  const analyze=$('#analyze');if(analyze)analyze.disabled=disabled||!state.tasks.length||!Object.values(state.records).some(r=>r.status==='pending');
  $('#ask').disabled=disabled||!state.tasks.length||!$('#question').value.trim();$('#attach').disabled=disabled||!state.tasks.length;
  $('#question').disabled=!state.tasks.length;
  renderUndo();
  $('#save-info').textContent=editDrafts.size?'建议有未保存的编辑':'已自动保存';
  const draft=editDrafts.get(editingId);if($('#inline-save')&&draft&&draft.version!==currentSuggestion()?.version)$('#inline-save').disabled=true;
  const a=$('#export-bundle');a.classList.toggle('disabled',!state.tasks.length);a.setAttribute('aria-disabled',String(!state.tasks.length));
}

function renderJob(){
  const j=state.job;
  if(!j||j.status==='completed'||j.kind==='question'){$('#job-status').innerHTML='';return;}
  $('#job-status').innerHTML=j.status==='running'?`<div class="job"><span class="spinner" aria-hidden="true"></span><div class="job-text"><strong>处理中</strong><p>${esc(j.stage)}</p><span class="small muted">可停留或刷新页面，服务端会继续处理。</span></div></div>`:`<div class="job failed"><div class="job-text"><strong>本次处理失败</strong><p>${esc(j.error)}</p><span class="small">正式任务表和已确认结果已保留。</span></div><button id="retry-job" class="${j.kind==='analysis'?'primary':''}">重试</button></div>`;
  if(j.status==='failed'&&$('#notice').textContent.includes('正在'))showNotice('本次处理失败，已保留已有结果。');
  if($('#retry-job'))$('#retry-job').onclick=()=>runAction(()=>api(j.kind==='question'?'/api/question':'/api/analyze',j.kind==='question'?{question:j.question}:{}));
}
function renderMessages(){
  const messages=state.messages.filter(m=>m.role==='user'||state.runs.some(r=>r.id===m.run_id&&r.kind==='question')).slice(-20);
  $('#conversation').hidden=!messages.length;
  $('#message-count').textContent=messages.length?`· ${messages.filter(m=>m.role==='user').length} 个问题`:'';
  $('#messages').innerHTML=messages.map(m=>`<div class="message ${esc(m.role)}"><span class="speaker">${m.role==='user'?'你':'聊有数'}</span>${esc(m.text)}${m.evidence?.length?`<details><summary>查看 ${m.evidence.length} 条原文依据</summary>${m.evidence.map(e=>`<div class="quote"><span class="quote-meta">${esc(e.record_id)}</span> ${esc(e.quote)}</div>`).join('')}</details>`:''}</div>`).join('');
  const j=state.job;
  if(j?.kind==='question'&&j.status==='running')$('#messages').innerHTML+='<div class="reply-pending" role="status"><span class="spinner" aria-hidden="true"></span>正在查找原文依据…</div>';
  if(j?.kind==='question'&&j.status==='failed'){
    $('#conversation').open=true;
    $('#messages').innerHTML+=`<div class="job failed"><div class="job-text"><strong>这次未能回答</strong><p>${esc(j.error)}</p><span class="small">任务表和已有结果已保留。</span></div><button id="retry-question">重试</button></div>`;
    $('#retry-question').onclick=()=>runAction(()=>api('/api/question',{question:j.question}));
  }
  const proposal=currentSuggestion();
  if(section==='assistant'&&proposal){
    $('#messages').insertAdjacentHTML('beforeend',`<button id="return-to-review" class="return-to-review">回到 ${esc(proposal.task_id||'待归属事项')} 的建议 <span aria-hidden="true">↑</span></button>`);
    $('#return-to-review').onclick=()=>{$('#conversation').open=false;$('#review-section').scrollIntoView({block:'start'});syncDecisionBar();};
  }
}

function openDialog(title,body,footer='',wide=false){
  $('#dialog').className=wide?'wide':'';
  $('#dialog-content').innerHTML=`<div class="dialog-header"><h2>${esc(title)}</h2><button id="dialog-close" aria-label="关闭窗口">×</button></div><div class="dialog-body">${body}<div id="dialog-error" role="alert" hidden></div></div>${footer?`<div class="dialog-footer">${footer}</div>`:''}`;
  $('#dialog-close').onclick=()=>$('#dialog').close();
  if(!$('#dialog').open)$('#dialog').showModal();
}
function dialogError(e){$('#dialog-error').hidden=false;$('#dialog-error').className='dialog-error';$('#dialog-error').textContent=e.message;}
function preview(kind,batchId=null){
  if(kind==='task'){if(!state.tasks.length)return;openDialog('任务表 · '+state.task_file.name,`<p>共 ${state.tasks.length} 项任务。下表是当前已确认结果，保留原始字段。</p>${tableHTML(state.tasks,state.headers)}`,'',true);}
  else{const b=batchId?state.batches.find(x=>x.id===batchId):state.batches[state.batches.length-1];if(!b)return;openDialog('聊天记录 · '+b.name,`<p>读取 ${b.count} 条，新增 ${b.new_count} 条，重复 ${b.duplicates} 条。</p>${tableHTML(b.record_ids.map(id=>state.records[id].row),['编号','时间','来源','内容'])}`,'',true);}
}
function decisionDialog(p,action){
  if(action==='edit'){editingId=p.id;startEditDraft(p);renderSuggestions();$('#inline-editor').scrollIntoView({block:'start'});return;}
  openDialog('不采纳这条建议',`<p>${esc(p.task_id||'待归属')} · ${esc(p.task_name)}</p><p>选择原因，也可以补充说明。任务表保持原样。</p><div class="reason-options">${['原安排已经包含','依据不足','与实际情况不符','暂不需要这项调整'].map(x=>`<button data-reject-reason="${x}">${x}</button>`).join('')}</div><label for="decision-note">不采纳理由</label><textarea id="decision-note" placeholder="选择上面的原因，或写下你的判断依据。"></textarea>`,`<button id="cancel-decision">取消</button><button id="save-decision" class="primary">记录不采纳</button>`);
  document.querySelectorAll('[data-reject-reason]').forEach(b=>b.onclick=()=>{document.querySelectorAll('[data-reject-reason]').forEach(x=>x.classList.remove('selected'));b.classList.add('selected');$('#decision-note').value=b.dataset.rejectReason;});
  $('#cancel-decision').onclick=()=>$('#dialog').close();
  $('#save-decision').onclick=async()=>{const b=$('#save-decision');b.disabled=true;try{const r=await api('/api/decision',{id:p.id,version:p.version,action:'reject',note:$('#decision-note').value});$('#dialog').close();showNotice(r.message,true);await load();$('.chat-scroll').scrollTop=0;}catch(e){dialogError(e);}finally{b.disabled=false;}};
}

async function readFile(file,max=5*1024*1024){if(file.size>max)throw Error('文件过大，请拆分后重试。');try{return new TextDecoder('utf-8',{fatal:true}).decode(await file.arrayBuffer());}catch(e){throw Error('无法读取文件编码，请另存为 CSV UTF-8（逗号分隔）后重试。');}}
async function upload(kind,file){
  const content=await readFile(file);
  try{return await api('/api/import/'+(kind==='task'?'tasks':'chat'),{content,filename:file.name});}
  catch(e){if(kind==='task'&&e.message.includes('与当前正式表不同')){
    openDialog('载入不同的任务表',`<p>这份表与当前正式表不同。继续当前项目时，建议恢复它配套的进度备份。</p><p>如果这是一个新项目，可以开始新的工作区。本机当前进度会留存快照；建议先下载备份，便于恢复。</p><a class="button" href="/api/export/backup">先下载当前进度</a>`,`<button id="keep-workspace">保留当前工作区</button><button id="new-workspace" class="primary">开始新的任务表</button>`);
    $('#keep-workspace').onclick=()=>$('#dialog').close();$('#new-workspace').onclick=()=>{$('#dialog').close();runAction(async()=>{const r=await api('/api/import/tasks',{content,filename:file.name,new_workspace:true});editDrafts.clear();editingId=null;reviewIndex=0;tableSearch='';return r;});};return;
  }throw e;}
}
for(const kind of ['task','chat'])$('#'+kind+'-file').onchange=e=>{const file=e.target.files[0];e.target.value='';if(file){captureEditDraft();runAction(async()=>{const r=await upload(kind,file);browsing=false;reviewOverride=false;filter='pending';editingId=null;section='assistant';return r;},()=>$('#'+kind+'-file').click());}};
$('#restore').onclick=()=>$('#restore-file').click();
$('#mobile-table').onclick=()=>{inspectorOpen=!inspectorOpen;renderShell();};
$('#next-batch').onclick=()=>$('#chat-file').click();
$('#restore-file').onchange=async e=>{
  const file=e.target.files[0];e.target.value='';if(!file)return;
  try{const data=JSON.parse(await readFile(file,125*1024*1024));openDialog('恢复保存的进度',`<p>将恢复备份中的任务表、建议、人工决定和去重记录。当前工作区也会在本机留存快照。</p><p>文件：${esc(file.name)}</p><p>保存时间：${esc(data.created_at||'未知')}</p><a href="/api/export/backup">先保存当前进度</a>`,`<button id="cancel-restore">取消</button><button id="confirm-restore" class="primary">恢复这份进度</button>`);$('#cancel-restore').onclick=()=>$('#dialog').close();$('#confirm-restore').onclick=()=>{$('#dialog').close();runAction(async()=>{const result=await api('/api/restore',data);section='assistant';browsing=false;reviewOverride=false;filter='pending';reviewIndex=0;editingId=null;editDrafts.clear();tableSearch='';return result;},()=>$('#restore-file').click());};}
  catch(e){showNotice('无法读取进度备份：'+e.message);}
};
function settings(){
  openDialog('模型连接设置',`<div class="model-status">${config.configured?'✓ 已填写连接配置（实际连通性以分析结果为准）':'尚未配置模型'}<br>当前模型：${esc(config.model||'未填写')} · 提示词 ${esc(config.prompt_version)}</div><p>密钥只由本地后端读取。请打开项目中的 <strong>.env</strong> 文件，填写后保存。无需重启。</p><pre>OPENAI_BASE_URL=https://api.deepseek.com\nOPENAI_API_KEY=在本地文件填写你的密钥\nOPENAI_MODEL=deepseek-flash</pre><p>使用其他服务时，替换地址和模型名。不要把密钥放到表格或聊天记录里。</p>`,`<button id="refresh-config" class="primary">已保存，刷新配置</button>`);
  $('#refresh-config').onclick=()=>{$('#dialog').close();runAction(async()=>{await load();return{message:config.configured?'配置已读取，可以开始分析。':'仍未检测到完整配置，请检查 .env。'};});};
};
function history(){return openDialog('操作日志',`<p>原始 AI 输出与完整调用材料包含在进度备份中。下方记录每次导入、分析和人工操作。</p>${state.events.length?state.events.slice().reverse().map(e=>`<div class="history-entry"><strong>${esc(actionNames[e.action]||e.action)}</strong> <span class="muted">${esc(new Date(e.time).toLocaleString('zh-CN'))}</span><p>${esc(e.note||e.error||e.name||(e.new_count!==undefined?`新增 ${e.new_count} 条，重复 ${e.duplicates} 条`:''))}</p></div>`).join(''):'<p>还没有处理记录。</p>'}`);}
$('#expand-table').onclick=()=>navigate('table');
$('#undo-last').onclick=undoDialog;
$('#search').oninput=e=>{search=e.target.value;renderTable();};
$('#question').oninput=()=>{const q=$('#question');q.style.height='auto';q.style.height=Math.min(q.scrollHeight,120)+'px';renderControls();};
$('#chat-form').onsubmit=e=>{
  e.preventDefault();const content=$('#question').value.trim();if(!content||locked())return;
  runAction(async()=>{const r=await api('/api/question',{question:content});$('#question').value='';$('#question').style.height='auto';$('#conversation').open=true;return r;});
};
$('#question').addEventListener('keydown',e=>{if(e.key==='Enter'&&!e.shiftKey&&!e.isComposing){e.preventDefault();if(!$('#ask').disabled)$('#chat-form').requestSubmit();}});
$('#attach').onclick=()=>$('#chat-file').click();
$('#add-context').onclick=supplementDialog;
function supplementDialog(){
  if(locked())return;
  openDialog('补充新情况','<p>写下刚确认的业务事实。我会把它加入聊天材料，分析后再由你核对。</p><label for="new-context">新的业务情况</label><textarea id="new-context" placeholder="例如：负责人刚确认，交付日调整到 19 日，其他安排不变。"></textarea>','<button id="cancel-context">取消</button><button id="save-context" class="primary" disabled>添加到材料</button>');
  $('#new-context').oninput=()=>$('#save-context').disabled=!$('#new-context').value.trim();
  $('#cancel-context').onclick=()=>$('#dialog').close();
  const record_id='U-'+crypto.randomUUID(),time=new Date().toLocaleString('zh-CN');
  $('#save-context').onclick=async()=>{const b=$('#save-context');b.disabled=true;
    try{captureEditDraft();await api('/api/supplement',{content:$('#new-context').value.trim(),record_id,time});$('#dialog').close();browsing=false;reviewOverride=false;section='assistant';editingId=null;await load();showNotice('新情况已加入材料，点击“开始分析”继续。',true);}
    catch(e){dialogError(e);b.disabled=false;}
  };
  $('#new-context').focus();
}

$('#dialog').addEventListener('click',e=>{if(e.target===$('#dialog')){const r=$('#dialog').getBoundingClientRect();if(e.clientX<r.left||e.clientX>r.right||e.clientY<r.top||e.clientY>r.bottom)$('#dialog').close();}});
load().catch(e=>showNotice(e.message,false,load));

function browseSuggestions(status,id=null){
  captureEditDraft();section='history';filter=status;browsing=true;editingId=null;historyIndex=0;
  if(id){const index=visibleSuggestions().findIndex(p=>p.id===id);if(index>=0)historyIndex=index;}
  if($('#dialog').open)$('#dialog').close();render();$('.chat-scroll').scrollTop=0;
}
$('#back-main').onclick=()=>{if(browsing){navigate('history');return;}reviewOverride=false;render();$('.chat-scroll').scrollTop=0;};
$('#review-history').onclick=()=>navigate('history');
$('#result-history').onclick=()=>navigate('history');
function downloadDialog(){
  if(!state.tasks.length)return;
  const waiting=state.suggestions.filter(p=>['pending','deferred'].includes(p.status)).length;
  openDialog('下载结果',`<p>${state.tasks.length} 项正式任务${waiting?`；${waiting} 条未确认建议单独保留`:''}。下载不会改变当前进度。</p><div class="download-options"><a class="download-option recommended" href="/api/export/table"><span><strong>任务表</strong><small>仅包含已确认内容，可用 Excel 打开</small></span><span class="file-type">CSV ↓</span></a><a class="download-option" href="/api/export/bundle"><span><strong>完整结果包</strong><small>任务表、变更说明和进度备份，方便转移或留档</small></span><span class="file-type">ZIP ↓</span></a></div><p class="download-help">继续下一批时，当前电脑会自动保留进度。换电脑请恢复结果包中的进度备份。</p>`);
}
function preferences(){
  openDialog('设置',`<div class="settings-section"><h3>模型连接</h3><button id="configure-model" class="setting-row"><span><strong>${esc(config.model||'尚未配置')}</strong><small>${config.configured?'已配置；连接情况以实际分析为准':'配置后才能分析聊天记录'}</small></span><span>查看 ›</span></button></div><div class="settings-section"><h3>进度备份</h3><p>平时会自动保存。换电脑或恢复先前进度时使用。</p><div class="backup-actions"><a class="button" href="/api/export/backup">保存备份</a><button id="restore-progress">恢复备份…</button></div></div>`);
  $('#configure-model').onclick=settings;
  $('#restore-progress').onclick=()=>{$('#dialog').close();$('#restore-file').click();};
}
$('#download').onclick=downloadDialog;
$('#export-bundle').onclick=downloadDialog;
$('#toolbar-undo').onclick=undoDialog;

// Navigation is separate from the saved business workflow; it never changes data.
function navigate(destination){
  captureEditDraft();section=destination;browsing=false;inspectorOpen=false;editingId=null;
  if($('#dialog').open)$('#dialog').close();render();
  document.body.classList.remove('sidebar-open');syncSidebarButton();
}
function renderShell(){
  syncSidebarButton();document.body.dataset.section=section;
  const detail=section==='history'&&browsing,showAssistant=section==='assistant'||detail;
  $('#assistant-view').hidden=!showAssistant;$('#library-view').hidden=showAssistant;
  for(const name of ['assistant','table','materials','history']){
    const b=$('#nav-'+name);b.classList.toggle('active',section===name);
    if(section===name)b.setAttribute('aria-current','page');else b.removeAttribute('aria-current');
  }
  const count=state.suggestions.filter(p=>p.status==='pending').length;
  $('#pending-count').hidden=!count;$('#pending-count').textContent=count;
  $('#page-title').textContent={assistant:'更新助手',table:'任务表',materials:'材料',history:'处理记录'}[section];
  $('#page-context').hidden=!showAssistant;
  $('#page-context').textContent=detail?statusNames[filter]:{prepare:'准备材料',processing:'分析中',review:'核对变化',done:'已保存'}[view];
  $('.journey').hidden=section!=='assistant';
  $('.right-column').hidden=!inspectorOpen||!showAssistant;
  $('#mobile-table').hidden=!showAssistant||!currentSuggestion()?.task_id;
  $('#mobile-table').setAttribute('aria-pressed',String(inspectorOpen));
  $('#download').hidden=!state.tasks.length;
  $('#toolbar-undo').hidden=!undoState;$('#toolbar-undo').disabled=locked()||Boolean(undoState?.blocked);$('#toolbar-undo').title=undoState?.blocked||'撤销上次确认';
  if(detail)$('#conversation').hidden=true;
  syncDecisionBar();
  if(section==='table')renderTablePage();
  if(section==='history'&&!browsing)renderHistoryPage();
  if(section==='materials')renderMaterialsPage();
}
function syncDecisionBar(){
  const p=currentSuggestion(),readingReply=section==='assistant'&&$('#conversation').open&&!$('#conversation').hidden;
  $('#decision-bar').hidden=!p||!['pending','deferred'].includes(p.status)||readingReply;
  const back=$('#return-to-review');
  if(back&&p)back.innerHTML=`回到 ${esc(p.task_id||'待归属事项')} 的建议 <span aria-hidden="true">↑</span>`;
}
$('#conversation').addEventListener('toggle',syncDecisionBar);
function renderMaterialsPage(){
  const batches=state.batches.slice().reverse();
  $('#library-content').innerHTML=`<div class="library-intro"><div><h2>用于更新的材料</h2><p>查看任务表和每批聊天的原文。</p></div></div><section class="material-section"><h3>任务表</h3>${state.task_file?`<div class="material-row"><span><strong>${esc(state.task_file.name)}</strong><small>${state.tasks.length} 项任务 · 预览显示当前已确认结果</small></span><button id="preview-current-table">预览</button></div><button id="replace-task" class="text-button">载入另一份任务表…</button>`:'<p>先上传已有任务表。</p><button id="replace-task" class="primary">上传任务表</button>'}</section><section class="material-section"><div class="section-title"><h3>聊天记录 <span>${batches.length} 批</span></h3><div><button id="add-material-context" class="text-button">补充新情况</button><button id="add-material-chat">添加聊天记录</button></div></div>${batches.length?batches.map(b=>`<button class="material-row material-batch" data-batch-preview="${esc(b.id)}"><span><strong>${esc(b.name)}</strong><small>${b.count} 条 · 新增 ${b.new_count} 条${b.duplicates?` · 重复 ${b.duplicates} 条`:''} · ${esc(new Date(b.time).toLocaleString('zh-CN'))}</small></span><span>查看原文 ›</span></button>`).join(''):'<p class="empty">还没有聊天记录。可以上传 CSV，也可以补充一段新情况。</p>'}</section>`;
  $('#replace-task').onclick=()=>$('#task-file').click();
  if($('#preview-current-table'))$('#preview-current-table').onclick=()=>preview('task');
  $('#add-material-chat').onclick=()=>$('#chat-file').click();
  $('#add-material-context').onclick=supplementDialog;$('#add-material-context').disabled=locked()||!state.tasks.length;
  $('#add-material-chat').disabled=locked();$('#replace-task').disabled=locked();
  document.querySelectorAll('[data-batch-preview]').forEach(b=>b.onclick=()=>preview('chat',b.dataset.batchPreview));
}

function renderTablePage(){
  const rows=state.tasks.filter(t=>Object.values(t).some(v=>String(v).includes(tableSearch)));
  $('#library-content').innerHTML=state.tasks.length?`<div class="library-intro"><div><h2>当前任务表</h2><p>${state.tasks.length} 项任务 · 只包含已确认的安排</p></div><div class="library-tools"><input id="table-search" type="search" aria-label="搜索正式任务" placeholder="搜索任务" value="${esc(tableSearch)}"><button id="table-download">下载结果 ↓</button></div></div><div id="table-page-rows" class="table-surface">${tableHTML(rows,state.headers)}</div><p class="library-note">待确认和待核实的建议不会写入这里。</p>`:`<div class="library-empty"><h2>还没有任务表</h2><p>上传已有任务表后，已确认的安排会保存在这里。</p><button id="table-start" class="primary">上传任务表</button></div>`;
  if($('#table-download'))$('#table-download').onclick=downloadDialog;
  if($('#table-start'))$('#table-start').onclick=()=>{$('#task-file').click();};
  if($('#table-search'))$('#table-search').oninput=e=>{tableSearch=e.target.value;const found=state.tasks.filter(t=>Object.values(t).some(v=>String(v).includes(tableSearch)));$('#table-page-rows').innerHTML=found.length?tableHTML(found,state.headers):'<div class="empty">没有找到匹配的任务。</div>';};
}
function renderHistoryPage(){
  const items=state.suggestions.filter(p=>historyFilter==='all'||p.status===historyFilter).slice().reverse();
  $('#library-content').innerHTML=`<div class="library-intro"><div><h2>处理记录</h2><p>查看修改、人工决定与聊天依据。</p></div><button id="event-history" class="text-button">查看操作日志 ↗</button></div><div class="history-filters" role="group" aria-label="筛选处理状态">${Object.entries({all:'全部',pending:'待确认',deferred:'待核实',confirmed:'已确认',rejected:'不采纳'}).map(([key,label])=>`<button data-history-filter="${key}" class="${key===historyFilter?'active':''}" aria-pressed="${key===historyFilter}">${label} ${key==='all'?state.suggestions.length:state.suggestions.filter(p=>p.status===key).length}</button>`).join('')}</div><div class="history-list">${items.length?items.map(p=>`<button class="history-item" data-history-id="${esc(p.id)}"><span><small>${esc(p.task_id||'待归属事项')}</small><strong>${esc(p.task_name)}</strong></span><span class="history-meta"><span class="badge ${p.status==='confirmed'?'success':p.status==='deferred'?'warning':''}">${statusNames[p.status]}</span><span aria-hidden="true">›</span></span></button>`).join(''):'<p class="empty">这里还没有记录。</p>'}</div>`;
  $('#event-history').onclick=history;
  document.querySelectorAll('[data-history-filter]').forEach(b=>b.onclick=()=>{historyFilter=b.dataset.historyFilter;renderHistoryPage();});
  document.querySelectorAll('[data-history-id]').forEach(b=>b.onclick=()=>{const p=state.suggestions.find(p=>p.id===b.dataset.historyId);browseSuggestions(p.status,p.id);});
}
$('#nav-assistant').onclick=()=>navigate('assistant');
$('#nav-table').onclick=()=>navigate('table');
$('#nav-history').onclick=()=>navigate('history');
$('#nav-materials').onclick=()=>navigate('materials');
$('#settings').onclick=preferences;
$('#close-inspector').onclick=()=>{inspectorOpen=false;renderShell();};
function syncSidebarButton(){
  const mobile=matchMedia('(max-width:600px)').matches;
  const open=mobile?document.body.classList.contains('sidebar-open'):!document.body.classList.contains('sidebar-collapsed');
  $('#sidebar-toggle').setAttribute('aria-expanded',String(open));$('#sidebar-toggle').setAttribute('aria-label',open?'收起侧栏':'展开侧栏');
}
$('#sidebar-toggle').onclick=()=>{
  document.body.classList.toggle(matchMedia('(max-width:600px)').matches?'sidebar-open':'sidebar-collapsed');
  syncSidebarButton();
};
matchMedia('(max-width:600px)').addEventListener('change',syncSidebarButton);

window.addEventListener('beforeunload',e=>{captureEditDraft();if([...editDrafts.values()].some(d=>d.dirty)){e.preventDefault();e.returnValue='';}});

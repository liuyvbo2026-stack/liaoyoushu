/* One decision at a time; the formal table only changes after confirmation. */
function markedChange(before,after){
  if(!before||!after)return esc(after)||'（空）';
  let start=0,end=0;
  while(start<before.length&&start<after.length&&before[start]===after[start])start++;
  while(end<before.length-start&&end<after.length-start&&before[before.length-1-end]===after[after.length-1-end])end++;
  return esc(after.slice(0,start))+(after.length-start-end?`<mark>${esc(after.slice(start,after.length-end))}</mark>`:'')+esc(end?after.slice(after.length-end):'');
}
function fieldDiff(c){
  if(['责任人','截止日'].includes(c.field)&&c.before.length<50&&c.after.length<50)return `<div class="compact-change"><span class="field-name">${esc(c.field)}</span><span class="compact-before">${esc(c.before)||'（空）'}</span><span class="change-arrow" aria-label="修改为">→</span><strong>${esc(c.after)||'（空）'}</strong></div>`;
  return `<div class="field-change"><div class="field-name">${esc(c.field)}</div><div class="field-values"><div class="old-value"><span>原来</span><p>${esc(c.before)||'（空）'}</p></div><div class="new-value"><span>建议</span><p>${markedChange(c.before,c.after)}</p></div></div></div>`;
}
function readableChanges(changes){
  if(!changes.length)return '';
  return `<div class="comparison-head"><span>更新字段</span><span>原来的安排</span><span>建议更新为</span></div>`+[...changes].sort((a,b)=>Number(!['责任人','截止日'].includes(a.field))-Number(!['责任人','截止日'].includes(b.field))).map(fieldDiff).join('');
}
function evidenceQuote(e,short=false){
  const text=short&&e.quote.length>130?e.quote.slice(0,130):e.quote;
  return `<div class="quote"><div class="quote-meta">${esc(e.record_id)} · ${esc(e.source)}${!short?' · '+esc(e.time):''}</div><p>“${esc(text)}”${text!==e.quote?'…':''}</p>${!short&&e.quote!==e.content?`<details><summary>查看完整记录</summary><p>${esc(e.content)}</p></details>`:''}</div>`;
}
function card(p){
  const references=p.evidence||[];
  return `<article class="suggestion" data-card="${esc(p.id)}"><div class="suggestion-header"><div class="card-top"><span class="task-ref">${esc(p.task_id||'待归属事项')}</span><div class="badges">${p.priority==='conflict'?'<span class="badge warning">存在冲突</span>':p.priority==='important'?'<span class="badge important">重点核对</span>':''}${p.status!=='pending'?`<span class="badge ${p.status==='confirmed'?'success':''}">${statusNames[p.status]}</span>`:''}${p.edited?'<span class="badge">已编辑</span>':''}</div></div><h3>${esc(p.task_name)}</h3></div>
  ${editingId===p.id?inlineEditor(p):`<div class="changes">${readableChanges(p.changes)}</div>`}
  ${!p.changes.length?'<p class="no-change">信息还不够，暂时不会修改任务表。</p>':''}
  ${p.questions.length?`<details class="questions" ${!p.changes.length?'open':''}><summary>${p.questions.length} 个问题需要核实${p.changes.length?'，可先保留':''}</summary><ul>${p.questions.map(q=>`<li>${esc(q)}</li>`).join('')}</ul></details>`:''}
  <div class="evidence-block"><p class="evidence-label">聊天依据</p><div class="evidence-preview ${p.priority==='conflict'?'conflict-evidence':''}">${references.slice(0,p.priority==='conflict'?2:1).map(e=>evidenceQuote(e,true)).join('')}</div>
  <details class="evidence-details"><summary>查看判断理由与全部依据 · ${references.length} 条</summary><p class="reason">${esc(p.reason)}</p>${references.map(e=>evidenceQuote(e)).join('')}<button id="ask-current" class="text-button">问问这条建议</button></details></div>
  ${p.status==='confirmed'||p.status==='rejected'?`<p class="processed-note">${statusNames[p.status]} · ${esc(p.history.at(-1)?.note||'已保存处理结果')}</p>`:''}
  ${p.status!=='pending'||p.edited?`<details class="audit-detail"><summary>原始建议与处理历史</summary><p>${esc(p.original.reason)}</p>${p.original.changes.map(c=>`<p>${esc(c.field)}：${esc(c.before)} → ${esc(c.after)}</p>`).join('')}${p.history.map(h=>`<p>${esc(actionNames[h.action]||h.action)}：${esc(h.note)}</p>`).join('')}</details>`:''}
  </article>`;
}
function startEditDraft(p){
  if(!editDrafts.has(p.id))editDrafts.set(p.id,{id:p.id,version:p.version,changes:p.changes.map(c=>({...c,keep:true})),note:'',dirty:false});
}
function captureEditDraft(){
  const editor=$('#inline-editor');if(!editor)return;
  const draft=editDrafts.get(editor.dataset.draftId);if(!draft)return;
  draft.changes.forEach((c,i)=>{const field=$('#edit-'+i),keep=$('#keep-'+i);if(field&&keep){if(c.after!==field.value||c.keep!==keep.checked)draft.dirty=true;c.after=field.value;c.keep=keep.checked;}});
  if($('#edit-note')){if(draft.note!==$('#edit-note').value)draft.dirty=true;draft.note=$('#edit-note').value;}
}
function inlineEditor(p){
  startEditDraft(p);const d=editDrafts.get(p.id);
  return `<div id="inline-editor" data-draft-id="${esc(p.id)}"><p class="editor-hint">正在编辑建议，尚未写入任务表。切换页面会保留草稿。</p>${d.changes.map((c,i)=>`<div class="edit-field"><label><input type="checkbox" id="keep-${i}" ${c.keep?'checked':''}> 修改${esc(c.field)}</label><p class="small muted">原来：${esc(c.before)||'（空）'}</p><textarea id="edit-${i}" aria-label="${esc(c.field)}建议值">${esc(c.after)}</textarea></div>`).join('')}<label for="edit-note">修改理由</label><textarea id="edit-note" placeholder="说明判断依据，方便后续核对。">${esc(d.note)}</textarea><div id="edit-error" class="dialog-error" ${d.version===p.version?'hidden':''} role="alert">${d.version!==p.version?'这条建议已在其他页面更新。草稿仍在；请取消编辑后核对新内容。':''}</div></div>`;
}
function visibleSuggestions(){
  const priorities={conflict:0,important:1,normal:2};
  const status=section==='history'&&browsing?filter:'pending';
  return state.suggestions.filter(p=>status==='all'||p.status===status).sort((a,b)=>(priorities[a.priority]??2)-(priorities[b.priority]??2));
}
function currentSuggestion(){return view==='review'&&(section==='assistant'||(section==='history'&&browsing))?visibleSuggestions()[section==='history'?historyIndex:reviewIndex]||null:null;}

function batchEligible(p){
  if(p.status!=='pending'||p.priority==='conflict'||p.questions.length||!p.changes.length)return false;
  const task=state.tasks.find(t=>t['编号']===p.task_id);
  return task&&p.changes.every(c=>task[c.field]===c.before);
}
function renderSuggestions(){
  captureEditDraft();
  const list=visibleSuggestions(),historical=section==='history'&&browsing;
  if(focusSuggestionId&&!historical){const idx=list.findIndex(p=>p.id===focusSuggestionId);if(idx>=0)reviewIndex=idx;focusSuggestionId=null;}
  if(historical)historyIndex=Math.min(historyIndex,Math.max(0,list.length-1));else reviewIndex=Math.min(reviewIndex,Math.max(0,list.length-1));
  const p=currentSuggestion(),index=historical?historyIndex:reviewIndex;activeTaskId=p?.task_id||null;
  if(p?.status==='pending'&&editDrafts.has(p.id))editingId=p.id;
  const eligible=state.suggestions.filter(batchEligible);
  $('#review-tools').innerHTML=!historical&&eligible.length>1?`<button id="batch-review" class="text-button">批量核对 ${eligible.length} 条无冲突建议</button>`:'';
  if($('#batch-review'))$('#batch-review').onclick=batchDialog;
  $('#review-navigation').innerHTML=p?`<div class="review-nav"><div class="nav-progress"><strong>${historical?statusNames[filter]:`还有 ${list.length} 条待核对`}</strong></div><div><span class="card-position">${index+1} / ${list.length}</span><button id="prev-card" class="quiet" aria-label="上一条建议" ${index===0?'disabled':''}>‹</button><button id="next-card" class="quiet" aria-label="下一条建议" ${index>=list.length-1?'disabled':''}>›</button></div></div>`:'';
  for(const [id,delta] of [['prev-card',-1],['next-card',1]])if($('#'+id))$('#'+id).onclick=()=>{captureEditDraft();if(historical)historyIndex+=delta;else reviewIndex+=delta;editingId=null;renderSuggestions();renderControls();renderShell();$('.chat-scroll').scrollTop=0;};
  $('#suggestions').innerHTML=p?card(p):'<div class="empty"><p>这里的建议已处理完。</p><button class="text-button" id="return-results">返回处理记录</button></div>';
  if($('#return-results'))$('#return-results').onclick=()=>navigate('history');
  if($('#ask-current'))$('#ask-current').onclick=()=>{const topic=`关于 ${p.task_id||p.task_name} 的建议，请解释判断依据。`;navigate('assistant');$('#question').value=topic;$('#question').focus();renderControls();};
  const bar=$('#decision-bar');bar.hidden=!p||!['pending','deferred'].includes(p.status);
  bar.innerHTML=!p?'':editingId===p.id?'<span class="decision-hint">保存编辑不会直接改表</span><div class="card-actions"><button id="inline-cancel">取消编辑</button><button id="inline-save" class="primary">保存建议</button></div>':p.status==='pending'?`<span class="decision-hint">${p.changes.length?'确认后，更新正式任务表':'可先保留，等信息补齐后再核对'}</span><div class="card-actions"><div><button data-decision="reject" data-id="${p.id}" class="text-button">不采纳</button>${p.changes.length?`<button data-decision="defer" data-id="${p.id}" class="text-button">稍后处理</button>`:''}</div><div>${p.changes.length?`<button data-decision="edit" data-id="${p.id}">编辑建议</button><button class="primary" data-decision="confirm" data-id="${p.id}">确认${p.changes.length>1?` ${p.changes.length} 项`:""}修改</button>`:`<button class="primary" data-decision="defer" data-id="${p.id}">保留，稍后核实</button>`}</div></div>`:p.status==='deferred'?`<span class="decision-hint">已保留，尚未写入任务表</span><div class="card-actions"><button data-decision="resume" data-id="${p.id}" class="primary">继续核对这条建议</button></div>`:'';
  if($('#inline-editor'))$('#inline-editor').oninput=()=>{captureEditDraft();$('#save-info').textContent='建议有未保存的编辑';};
  if($('#inline-cancel'))$('#inline-cancel').onclick=()=>{editDrafts.delete(p.id);editingId=null;renderSuggestions();renderControls();};
  if($('#inline-save'))$('#inline-save').onclick=async()=>{
    captureEditDraft();const d=editDrafts.get(p.id);busy=true;renderControls();
    try{const changes=d.changes.flatMap(c=>c.keep?[{field:c.field,after:c.after}]:[]);const r=await api('/api/decision',{id:p.id,version:d.version,action:'edit',changes,note:d.note});editDrafts.delete(p.id);editingId=null;showNotice(r.message,true);await load();$('.chat-scroll').scrollTop=0;}
    catch(e){if($('#edit-error')){$('#edit-error').hidden=false;$('#edit-error').textContent=e.message;}else showNotice(e.message);}finally{busy=false;renderControls();}
  };
  bar.querySelectorAll('[data-decision]').forEach(b=>b.onclick=()=>{
    const action=b.dataset.decision;
    if(['confirm','defer','resume'].includes(action))runAction(async()=>{const r=await api('/api/decision',{id:p.id,version:p.version,action});if(action==='resume'){section='assistant';filter='pending';browsing=false;reviewOverride=Object.values(state.records).some(r=>r.status==='pending');focusSuggestionId=p.id;}editingId=null;$('.chat-scroll').scrollTop=0;return r;});
    else decisionDialog(p,action);
  });
  renderTable();
  syncDecisionBar();
}


function changeList(changes, undo = false) {
  return changes.map(c => `<div class="diff"><div class="diff-label">${esc(c.field)}</div><div class="diff-values"><div class="before"><small>${undo ? '当前' : '原来'}</small>${esc(undo ? c.after : c.before)}</div><div class="after"><small>${undo ? '撤销后恢复为' : '确认后'}</small>${esc(undo ? c.before : c.after)}</div></div></div>`).join('');
}

function batchDialog() {
  const candidates = state.suggestions.filter(batchEligible);
  openDialog('批量核对修改', `<p>只列出没有冲突、没有待核实问题且原值仍有效的建议。请阅读差异和依据，勾选你要确认的项目。</p>${candidates.map(p => `<section class="batch-item"><label class="batch-choice"><input type="checkbox" data-batch-id="${esc(p.id)}"><strong>${esc(p.task_id)} · ${esc(p.task_name)}</strong></label>${changeList(p.changes)}<p>${esc(p.reason)}</p><details><summary>查看聊天依据 · ${p.evidence.length} 条</summary>${p.evidence.map(e => `<div class="quote"><span class="quote-meta">${esc(e.record_id)} · ${esc(e.source)}</span>${esc(e.quote)}</div>`).join('')}</details></section>`).join('')}`, '<button id="cancel-batch">取消</button><button class="primary" id="confirm-batch" disabled>请先勾选建议</button>');
  $('#cancel-batch').onclick = () => $('#dialog').close();
  const selected = () => [...$('#dialog').querySelectorAll('[data-batch-id]:checked')].map(el => candidates.find(p => p.id === el.dataset.batchId));
  $('#dialog').querySelectorAll('[data-batch-id]').forEach(el => el.onchange = () => {
    const n = selected().length;
    $('#confirm-batch').disabled = !n;
    $('#confirm-batch').textContent = n ? `确认选中的 ${n} 条修改` : '请先勾选建议';
  });
  $('#confirm-batch').onclick = async () => {
    const button = $('#confirm-batch'); button.disabled = true;
    try {
      const items = selected().map(p => ({id: p.id, version: p.version}));
      const result = await api('/api/confirm-batch', {items});
      $('#dialog').close(); showNotice(result.message, true); await load();
    } catch (e) { dialogError(e); }
    finally { button.disabled = !selected().length; }
  };
}

function renderUndo() {
  $('#undo-last').hidden=true;
  const button = $('#toolbar-undo');
  button.hidden = !undoState;
  button.disabled = locked() || Boolean(undoState?.blocked);
  button.title = undoState?.blocked || '先查看将恢复的字段，再撤销';
  button.setAttribute('aria-label',undoState?.items.length > 1 ? `撤销上次批量确认（${undoState.items.length} 条）` : '撤销上次确认');
}

function undoDialog() {
  const info = undoState;
  if (!info || info.blocked) return;
  openDialog('撤销上次确认', `<p>下面 ${info.items.length} 条建议将恢复原值，并回到待确认。其他字段保持当前内容，操作历史会保留。</p>${info.items.map(p => `<section class="batch-item"><h3>${esc(p.task_id)} · ${esc(p.task_name)}</h3>${changeList(p.changes, true)}</section>`).join('')}`, '<button id="cancel-undo">保留当前结果</button><button id="confirm-undo" class="primary">确认撤销并恢复原值</button>');
  $('#cancel-undo').onclick = () => $('#dialog').close();
  $('#confirm-undo').onclick = async () => {
    const button = $('#confirm-undo'); button.disabled = true;
    try {
      const result = await api('/api/undo-confirm', {operation_id: info.id});
      section='assistant';browsing=false;reviewOverride=Object.values(state.records).some(r=>r.status==='pending');filter='pending';focusSuggestionId=info.items[0]?.id;
      $('#dialog').close(); showNotice(result.message, true); await load();
    } catch (e) { dialogError(e); }
    finally { button.disabled = false; }
  };
}

/* Formal table rendering and suggestion-to-row navigation. */
function tableHTML(rows, headers, linked = false) {
  const p = linked ? currentSuggestion() : null;
  const fields = new Set(p?.changes.map(c => c.field) || []);
  return `<div class="table-wrap"><table><thead><tr>${headers.map(h => `<th scope="col">${esc(h)}</th>`).join('')}</tr></thead><tbody>${rows.map(r => {
    const active = linked && r['编号'] === activeTaskId;
    return `<tr ${linked ? `data-task-id="${esc(r['编号'])}"` : ''} class="${active ? 'active-task' : ''}" ${active ? 'aria-current="true"' : ''}>${headers.map(h => `<td class="${active && fields.has(h) ? 'related-field' : ''}">${esc(r[h]) || '<span class="muted">—</span>'}</td>`).join('')}</tr>`;
  }).join('')}</tbody></table></div>`;
}

function renderTable(){
  const p=currentSuggestion(),task=state.tasks.find(t=>t['编号']===p?.task_id);
  const fields=new Set(p?.changes.map(c=>c.field)||[]);
  $('#table-focus').hidden=!task;$('#table-focus').textContent=task?`${task['编号']} · 已确认的正式值`:'';
  $('#task-table').innerHTML=task?`<div class="task-summary"><h3>${esc(task['工作项'])}</h3><div class="inspector-fields">${state.headers.filter(h=>!['编号','工作项'].includes(h)).map(h=>`<div class="${fields.has(h)?'related-field':''}"><span>${esc(h)}</span><p>${esc(task[h])||'（空）'}</p></div>`).join('')}</div><p class="formal-label">${p&&['pending','deferred'].includes(p.status)?'待确认建议尚未写入这里':'当前已保存的结果'}</p></div>`:'<p class="muted small">这条记录还无法归入具体任务。</p>';
  $('#table-toolbar').hidden=true;$('#task-list').hidden=true;
}

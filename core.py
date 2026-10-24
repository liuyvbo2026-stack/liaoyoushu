"""聊有数：持久状态、CSV 和建议校验。仅确认操作可修改已载入任务。"""
import copy
import csv
import hashlib
import io
import json
import os
import sqlite3
import threading
import uuid
from datetime import datetime, timezone
from pathlib import Path

TASK_FIELDS = ['编号', '工作项', '责任人', '当前安排', '截止日', '验收条件']
CHAT_FIELDS = ['编号', '时间', '来源', '内容']
EDIT_FIELDS = TASK_FIELDS[1:]
MAX_FILE = 5 * 1024 * 1024

class AppError(Exception):
    def __init__(self, message, status=400):
        super().__init__(message)
        self.status = status

def now():
    return datetime.now(timezone.utc).isoformat()

def uid():
    return uuid.uuid4().hex

def dump(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(',', ':'))

def digest(value):
    return hashlib.sha256(dump(value).encode()).hexdigest()

def text_value(value, name, limit=16000, empty=True):
    if not isinstance(value, str) or len(value) > limit or '\x00' in value:
        raise AppError(f'{name}必须是有效文字，且不超过 {limit} 字。')
    if not empty and not value.strip():
        raise AppError(f'{name}不能为空。')
    return value

def parse_csv(content, kind):
    text_value(content, '文件内容', MAX_FILE)
    if '\ufffd' in content:
        raise AppError('文件包含无法识别的字符，请在表格软件中另存为“CSV UTF-8（逗号分隔）”后重试。')
    required = TASK_FIELDS if kind == 'tasks' else CHAT_FIELDS
    try:
        reader = csv.reader(io.StringIO(content.lstrip('\ufeff'), newline=''), strict=True)
        headers = [h.strip() for h in next(reader)]
        if len(headers) != len(set(headers)) or '' in headers:
            raise AppError('列名重复或为空。请确保首行每个字段名称唯一。')
        missing = [h for h in required if h not in headers]
        if missing:
            raise AppError('缺少必需字段：' + '、'.join(missing) + '。请修正 CSV 首行列名，并使用英文逗号分隔。')
        rows, ids = [], set()
        for line, cells in enumerate(reader, 2):
            if not cells or all(not x.strip() for x in cells):
                continue
            if len(cells) != len(headers):
                raise AppError(f'第 {line} 行有 {len(cells)} 列，表头有 {len(headers)} 列。含逗号或换行的内容请用双引号包住。')
            row = dict(zip(headers, cells))
            row['编号'] = row['编号'].strip()
            for key, value in row.items():
                text_value(value, f'第 {line} 行「{key}」')
            for key in (['编号', '工作项'] if kind == 'tasks' else CHAT_FIELDS):
                if not row[key].strip():
                    raise AppError(f'第 {line} 行「{key}」为空，请补齐后重试。')
            if row['编号'] in ids:
                raise AppError(f'第 {line} 行编号「{row["编号"]}」重复，请为每条记录设置唯一编号。')
            ids.add(row['编号']); rows.append(row)
        if not rows:
            raise AppError('文件只有表头，没有记录。请补充数据后重试。')
        if len(rows) > (500 if kind == 'tasks' else 5000):
            raise AppError('记录过多：任务表最多 500 项，单次聊天最多 5000 条。请拆分文件。')
        return headers, rows
    except (csv.Error, StopIteration) as e:
        raise AppError('CSV 读取失败，请检查引号是否闭合、首行是否为字段名。') from e

def export_csv(headers, rows):
    out = io.StringIO(newline='')
    writer = csv.DictWriter(out, fieldnames=headers, lineterminator='\r\n')
    writer.writeheader(); writer.writerows(rows)
    return '\ufeff' + out.getvalue()

def blank_state():
    return {'schema':1, 'workspace_id':uid(), 'revision':0, 'headers':TASK_FIELDS[:], 'tasks':[],
            'task_file':None, 'records':{}, 'batches':[], 'suggestions':[], 'runs':[],
            'messages':[], 'events':[], 'job':None, 'saved_at':now()}

def ensure_idle(s):
    if s['job'] and s['job']['status'] == 'running':
        raise AppError('正在分析或回答，请等待完成后再操作。',409)

def event(s, action, data):
    s['events'].append({'id':uid(), 'time':now(), 'action':action, **data})

class Store:
    def __init__(self, path):
        self.path = Path(path)
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self.lock = threading.RLock()
        with self.connection() as c:
            c.execute('CREATE TABLE IF NOT EXISTS state (id INTEGER PRIMARY KEY CHECK(id=1), body TEXT NOT NULL)')
            c.execute('CREATE TABLE IF NOT EXISTS checkpoints (id TEXT PRIMARY KEY, time TEXT, reason TEXT, body TEXT)')
            c.execute('INSERT OR IGNORE INTO state VALUES (1,?)',(dump(blank_state()),))
        os.chmod(self.path, 0o600)
        s = self.read()
        if s['job'] and s['job']['status'] == 'running':
            def recover(state):
                state['job'].update(status='failed', error='上次服务在处理中停止，已保留正式表和已确认结果，请重试。', finished_at=now())
            self.update(recover)

    def connection(self):
        c = sqlite3.connect(str(self.path), timeout=10)
        c.execute('PRAGMA synchronous=FULL')
        return c

    def read(self):
        with self.lock, self.connection() as c:
            return json.loads(c.execute('SELECT body FROM state WHERE id=1').fetchone()[0])

    def update(self, change):
        with self.lock, self.connection() as c:
            c.execute('BEGIN IMMEDIATE')
            s = json.loads(c.execute('SELECT body FROM state WHERE id=1').fetchone()[0])
            result = change(s)
            s['revision'] += 1; s['saved_at'] = now()
            c.execute('UPDATE state SET body=? WHERE id=1',(dump(s),))
            return result

    def replace(self, new, reason):
        with self.lock, self.connection() as c:
            c.execute('BEGIN IMMEDIATE')
            old = json.loads(c.execute('SELECT body FROM state WHERE id=1').fetchone()[0]); ensure_idle(old)
            c.execute('INSERT INTO checkpoints VALUES (?,?,?,?)',(uid(),now(),reason,dump(old)))
            new = copy.deepcopy(new); new['revision'] = old['revision'] + 1; new['saved_at'] = now()
            c.execute('UPDATE state SET body=? WHERE id=1',(dump(new),))

    def import_tasks(self, content, filename, new_workspace=False):
        headers, tasks = parse_csv(content, 'tasks')
        filename = Path(text_value(filename,'文件名',200)).name
        if new_workspace:
            s=blank_state();s.update(headers=headers,tasks=tasks,task_file={'name':filename,'count':len(tasks)})
            event(s,'import_tasks',{'name':filename,'count':len(tasks)});self.replace(s,'开始新的任务表')
            return {'message':'已开始新的任务表；原工作区已在本机留存快照。'}
        def change(s):
            ensure_idle(s)
            if s['tasks'] and (s['headers'] != headers or digest(s['tasks']) != digest(tasks)):
                raise AppError('这份任务表与当前正式表不同。请恢复配套进度备份，或明确选择“开始新的任务表”。当前数据没有改变。',409)
            if s['tasks']:
                return {'message':'已重新载入相同正式表，聊天去重记录和人工决定均保留。'}
            s.update(headers=headers,tasks=tasks,task_file={'name':filename,'count':len(tasks)})
            event(s,'import_tasks',{'name':filename,'count':len(tasks)})
            return {'message':f'任务表读取成功，共 {len(tasks)} 项。'}
        return self.update(change)

    def import_chat(self, content, filename):
        _, rows = parse_csv(content,'chat')
        filename = Path(text_value(filename,'文件名',200)).name
        def change(s):
            ensure_idle(s)
            conflicts = [r['编号'] for r in rows if r['编号'] in s['records'] and s['records'][r['编号']]['fingerprint'] != digest({k:r[k] for k in CHAT_FIELDS})]
            if conflicts:
                raise AppError('聊天编号内容冲突：' + '、'.join(conflicts[:15]) + '。本次文件没有导入。若为新增事实，请使用新编号；若为错误，请修正文件后重试。',409)
            fresh = [r for r in rows if r['编号'] not in s['records']]
            duplicate = len(rows)-len(fresh); batch_id=uid()
            for row in fresh:
                row = {k:row[k] for k in CHAT_FIELDS}
                s['records'][row['编号']]={'row':row,'fingerprint':digest(row),'status':'pending','batch_id':batch_id}
            batch={'id':batch_id,'name':filename,'count':len(rows),'new_count':len(fresh),'duplicates':duplicate,'record_ids':[r['编号'] for r in rows],'time':now()}
            s['batches'].append(batch)
            event(s,'import_chat',{'batch_id':batch_id,'new_count':len(fresh),'duplicates':duplicate})
            return {'message':f'已读入 {len(rows)} 条，新增 {len(fresh)} 条，重复 {duplicate} 条。' + ('重复记录不会再次分析，也不会覆盖人工处理。' if duplicate else '')}
        return self.update(change)

    def decide(self, sid, action, version, changes=None, note=''):
        text_value(note, '处理理由', 4000)
        return self.update(lambda s: apply_decision(s, sid, action, version, changes, note))

    def confirm_batch(self, items):
        if not isinstance(items, list) or not 1 <= len(items) <= 100:
            raise AppError('请选择 1–100 条建议。')
        def change(s):
            ensure_idle(s)
            seen = set()
            fields = set()
            for item in items:
                if not isinstance(item, dict) or set(item) != {'id', 'version'} or not isinstance(item['id'], str):
                    raise AppError('批量确认格式无效。')
                if item['id'] in seen:
                    raise AppError('同一条建议不能重复选择。')
                seen.add(item['id'])
                p = next((p for p in s['suggestions'] if p['id'] == item['id']), None)
                if not p or p['status'] != 'pending' or p['version'] != item['version']:
                    raise AppError('选中的建议已变化，请刷新后重新核对。', 409)
                if p['priority'] == 'conflict' or p['questions'] or not p['changes']:
                    raise AppError('存在冲突或待核实问题的建议，请逐条核对。')
                for c in p['changes']:
                    key = (p['task_id'], c['field'])
                    if key in fields:
                        raise AppError('所选建议修改了同一任务的相同字段，请逐条核对。')
                    fields.add(key)
            operation_id = uid()
            for item in items:
                apply_decision(s, item['id'], 'confirm', item['version'],
                               note='用户核对后批量确认', operation_id=operation_id)
            return {'message': f'已确认 {len(items)} 条建议，可撤销这次批量确认。'}
        return self.update(change)

    def undo_confirm(self, operation_id):
        text_value(operation_id, '确认记录', 100, False)
        def change(s):
            ensure_idle(s)
            info = undo_info(s)
            if not info or info['id'] != operation_id:
                raise AppError('最近一次确认已变化，请重新查看撤销内容。', 409)
            if info['blocked']:
                raise AppError(info['blocked'], 409)
            for item in info['items']:
                p = next(p for p in s['suggestions'] if p['id'] == item['id'])
                task = next(t for t in s['tasks'] if t['编号'] == p['task_id'])
                for c in item['changes']:
                    task[c['field']] = c['before']
                p['status'] = 'pending'
                p['final_result'] = None
                p['version'] += 1
                p['history'].append({'action': 'undo_confirm', 'note': '撤销确认，恢复原值并重新核对',
                                     'time': now(), 'changes': copy.deepcopy(item['changes'])})
            event(s, 'undo_confirm', {'operation_id': operation_id,
                                      'note': f'撤销 {len(info["items"])} 条确认，恢复为待确认',
                                      'suggestion_ids': [p['id'] for p in info['items']]})
            return {'message': f'已撤销 {len(info["items"])} 条确认，原值已恢复，建议回到待确认。'}
        return self.update(change)

    def backup(self):
        state=self.read()
        if state['job'] and state['job']['status']=='running':
            state['job']={**state['job'],'status':'failed','error':'备份生成时尚在处理中，请重新发起。'}
        return {'format':'liaoyoushu-backup','version':1,'created_at':now(),'task_digest':digest(state['tasks']),'checksum':digest(state),'state':state}

    def restore(self, envelope):
        validate_backup(envelope)
        self.replace(envelope['state'],'恢复进度备份')
        return {'message':'进度已恢复，包含正式表、待确认建议、聊天去重记录和人工处理历史。'}

def apply_decision(s, sid, action, version, changes=None, note='', operation_id=None):
    """Apply a single decision inside the caller's transaction."""
    ensure_idle(s)
    p = next((p for p in s['suggestions'] if p['id'] == sid), None)
    if not p:
        raise AppError('找不到这条建议，请刷新页面。', 404)
    allowed_status = 'deferred' if action == 'resume' else 'pending'
    if p['status'] != allowed_status or p['version'] != version:
        raise AppError('这条建议已被处理或更新，请刷新查看最新结果。', 409)
    task = next((t for t in s['tasks'] if t['编号'] == p['task_id']), None)
    if action == 'edit':
        if not note.strip():
            raise AppError('请填写修改理由，方便后续核对。')
        if not isinstance(changes, list) or not changes:
            raise AppError('请至少保留一个修改字段。')
        original = {c['field']: c for c in p['changes']}
        seen, new = set(), []
        for c in changes:
            if not isinstance(c, dict) or set(c) != {'field', 'after'} or c['field'] not in original or c['field'] in seen:
                raise AppError('编辑只能调整这条建议已有的字段。')
            seen.add(c['field'])
            old = original[c['field']]
            after = text_value(c['after'], '建议值')
            if after != old['before']:
                new.append({**old, 'after': after})
        if not new:
            raise AppError('编辑后没有变化；可以选择“不采纳”。')
        p['changes'], p['edited'] = new, True
    elif action == 'reject':
        if not note.strip():
            raise AppError('请填写不采纳理由。')
        p['status'], p['final_result'] = 'rejected', None
    elif action == 'defer':
        p['status'] = 'deferred'
    elif action == 'resume':
        p['status'] = 'pending'
    elif action == 'confirm':
        if not p['changes'] or not task:
            raise AppError('这条建议只有待核实问题，可暂时保留或不采纳，不能直接改表。')
        for c in p['changes']:
            if task[c['field']] != c['before']:
                raise AppError(f'「{c["field"]}」已被其他确认修改，这条建议已过期。请不采纳旧建议，并补充新记录后重新分析。', 409)
        for c in p['changes']:
            task[c['field']] = c['after']
        p['status'], p['final_result'] = 'confirmed', copy.deepcopy(task)
    else:
        raise AppError('未知处理方式。')
    defaults = {'confirm': '用户确认 AI 建议', 'defer': '暂时保留，等待核实后继续处理', 'resume': '重新加入待确认列表'}
    entry = {'action': action, 'note': note or defaults.get(action, ''), 'time': now(), 'changes': copy.deepcopy(p['changes'])}
    p['history'].append(entry)
    p['version'] += 1
    data = {'suggestion_id': sid, 'task_id': p['task_id'], 'note': entry['note'], 'changes': copy.deepcopy(p['changes'])}
    if action == 'confirm':
        data['operation_id'] = operation_id or uid()
    event(s, action, data)
    return {'message': {'edit': '编辑已保存，仍需点击“确认修改”才会写入正式表。',
                        'reject': '已记录为不采纳，正式表没有变化。',
                        'confirm': '修改已确认并保存到正式表。',
                        'defer': '已暂时保留，可在“待核实”中继续处理，任务表没有变化。',
                        'resume': '已回到待确认列表，任务表没有变化。'}[action]}


def undo_info(s):
    """Find the latest non-reverted confirmation, including pre-upgrade records."""
    reverted = {e.get('operation_id') for e in s['events'] if e['action'] == 'undo_confirm'}
    latest = next((e for e in reversed(s['events']) if e['action'] == 'confirm'
                   and e.get('operation_id', e['id']) not in reverted), None)
    if not latest:
        return None
    operation_id = latest.get('operation_id', latest['id'])
    events = [e for e in s['events'] if e['action'] == 'confirm'
              and e.get('operation_id', e['id']) == operation_id]
    items, blocked = [], ''
    for e in events:
        p = next((p for p in s['suggestions'] if p['id'] == e['suggestion_id']), None)
        task = next((t for t in s['tasks'] if p and t['编号'] == p['task_id']), None)
        if not p or p['status'] != 'confirmed' or not task or any(task.get(c['field']) != c['after'] for c in e['changes']):
            blocked = '相关建议或字段已有变化，无法直接撤销；当前任务表未改变。'
        if p:
            items.append({'id': p['id'], 'task_id': p['task_id'], 'task_name': p['task_name'], 'changes': copy.deepcopy(e['changes'])})
    return {'id': operation_id, 'items': items, 'blocked': blocked, 'time': latest['time']}


def validate_suggestions(payload, tasks, records, new_ids):
    if not isinstance(payload,dict) or set(payload)!={'summary','suggestions'}:
        raise AppError('模型返回格式不符：必须包含 summary 和 suggestions。')
    text_value(payload['summary'],'分析总结',8000)
    if not isinstance(payload['suggestions'],list) or len(payload['suggestions'])>len(tasks)+20:
        raise AppError('模型返回的建议列表无效或过多。')
    task_map={t['编号']:t for t in tasks};seen=set();out=[]
    for index,p in enumerate(payload['suggestions'],1):
        if not isinstance(p,dict) or set(p)!={'task_id','reason','priority','changes','evidence','questions'}:
            raise AppError(f'第 {index} 条建议的字段结构不正确。')
        tid=p['task_id']
        if tid is not None and (not isinstance(tid,str) or tid not in task_map):
            raise AppError(f'第 {index} 条建议引用了不存在的任务编号。')
        if tid is not None and tid in seen: raise AppError(f'同一任务 {tid} 返回了多张建议，请重试。')
        seen.add(tid)
        text_value(p['reason'],'修改理由',8000,False)
        if p['priority'] not in ['conflict','important','normal']: raise AppError('建议优先级无效。')
        if not isinstance(p['questions'],list) or len(p['questions'])>20: raise AppError('待核实问题格式无效。')
        for q in p['questions']: text_value(q,'待核实问题',4000,False)
        if not isinstance(p['evidence'],list) or not p['evidence'] or len(p['evidence'])>100:
            raise AppError('建议缺少有效聊天依据。')
        evidence=[];eids=set()
        for e in p['evidence']:
            if not isinstance(e,dict) or set(e)!={'record_id','quote'}: raise AppError('聊天依据结构无效。')
            rid=e['record_id'];quote=text_value(e['quote'],'引用原文',16000,False)
            if not isinstance(rid,str) or rid not in records: raise AppError('模型引用了不存在的聊天编号。')
            row=records[rid]['row']
            if quote not in row['内容']: raise AppError(f'引用 {rid} 不是原文，已拒绝整批建议。请重试。')
            evidence.append({**e,'source':row['来源'],'time':row['时间'],'content':row['内容']});eids.add(rid)
        if not eids.intersection(new_ids): raise AppError('建议没有本批新记录依据，已阻止重复生成旧行动。')
        if not isinstance(p['changes'],list) or len(p['changes'])>len(EDIT_FIELDS): raise AppError('修改字段列表无效。')
        if not p['changes'] and not p['questions']: raise AppError('空建议缺少待核实问题。')
        fields=set()
        for c in p['changes']:
            if not isinstance(c,dict) or set(c)!={'field','before','after','evidence_ids'}: raise AppError('修改字段结构不符。')
            f=c['field']
            if not isinstance(f,str) or f not in EDIT_FIELDS or f in fields or tid is None: raise AppError('模型返回了不允许修改的字段。')
            fields.add(f)
            text_value(c['before'],'原值');text_value(c['after'],'建议值')
            if c['before']!=task_map[tid][f]: raise AppError(f'{tid}「{f}」原值不符，已拒绝写入建议。')
            if c['after']==c['before']: raise AppError(f'{tid}「{f}」没有变化，不应生成修改。')
            if not isinstance(c['evidence_ids'],list) or not c['evidence_ids'] or any(not isinstance(i,str) or i not in eids for i in c['evidence_ids']):
                raise AppError('修改字段没有有效的逐字段依据。')
        item=copy.deepcopy(p)
        item.update(id=uid(),task_name=task_map[tid]['工作项'] if tid else '尚未归属具体任务',evidence=evidence,
                    status='pending',version=1,edited=False,original=copy.deepcopy(p),history=[],final_result=None,created_at=now())
        if fields.intersection({'责任人','截止日'}) and item['priority']=='normal': item['priority']='important'
        out.append(item)
    return sorted(out,key=lambda p:{'conflict':0,'important':1,'normal':2}[p['priority']])

def validate_backup(env):
    try:
        if not isinstance(env,dict) or env.get('format')!='liaoyoushu-backup' or env.get('version')!=1:
            raise ValueError()
        s=env['state']
        if set(s)!=set(blank_state()) or s['schema']!=1 or digest(s)!=env['checksum'] or digest(s['tasks'])!=env['task_digest']:
            raise ValueError()
        if not isinstance(s['revision'],int) or not isinstance(s['workspace_id'],str): raise ValueError()
        if not isinstance(s['tasks'],list) or len(s['tasks'])>500 or not isinstance(s['headers'],list): raise ValueError()
        if s['tasks']:
            _, parsed=parse_csv(export_csv(s['headers'],s['tasks']),'tasks')
            if parsed!=s['tasks']: raise ValueError()
        elif s['headers']!=TASK_FIELDS: raise ValueError()
        if not isinstance(s['records'],dict) or len(s['records'])>20000: raise ValueError()
        for rid,r in s['records'].items():
            if set(r)!={'row','fingerprint','status','batch_id'} or r['row']['编号']!=rid or set(r['row'])!=set(CHAT_FIELDS) or digest(r['row'])!=r['fingerprint'] or r['status'] not in ['pending','analyzed']:
                raise ValueError()
            for value in r['row'].values(): text_value(value,'聊天内容')
        for key in ['batches','suggestions','runs','messages','events']:
            if not isinstance(s[key],list): raise ValueError()
        task_ids={t['编号'] for t in s['tasks']};ids=set()
        for p in s['suggestions']:
            if p['id'] in ids or p['status'] not in ['pending','deferred','confirmed','rejected'] or not isinstance(p['version'],int): raise ValueError()
            ids.add(p['id'])
            if p['task_id'] is not None and p['task_id'] not in task_ids: raise ValueError()
            if not isinstance(p['history'],list) or not isinstance(p['original'],dict): raise ValueError()
            fields=set()
            for c in p['changes']:
                if c['field'] not in EDIT_FIELDS or c['field'] in fields: raise ValueError()
                fields.add(c['field']);text_value(c['before'],'原值');text_value(c['after'],'建议值')
            for e in p['evidence']:
                if e['record_id'] not in s['records'] or e['quote'] not in s['records'][e['record_id']]['row']['内容']: raise ValueError()
        if s['job'] and s['job'].get('status') not in ['failed','completed']: raise ValueError()
    except (KeyError,TypeError,ValueError,AppError):
        raise AppError('备份损坏、版本不兼容或记录不一致，未改变当前数据。请使用“保存进度备份”生成的完整 JSON 文件。')

def change_summary(s):
    lines=['# 聊有数 · 变更说明','',f'导出时间：{now()}','正式 CSV 仅包含已确认结果；以下待确认建议和问题未写入正式表。','']
    for label,status in [('已确认修改','confirmed'),('待确认（未写入正式表）','pending'),('待核实 / 暂时保留（未写入正式表）','deferred'),('不采纳','rejected')]:
        lines.extend(['## '+label,''])
        items=[p for p in s['suggestions'] if p['status']==status]
        if not items: lines.extend(['无','']);continue
        for p in items:
            lines.append(f'### {p["task_id"] or "待归属"} · {p["task_name"]}')
            for c in p['changes']: lines.append(f'- {c["field"]}：{c["before"]} → {c["after"]}')
            lines.append('理由：'+p['reason'])
            for e in p['evidence']: lines.append(f'依据 {e["record_id"]}（{e["source"]}）：{e["quote"]}')
            for q in p['questions']: lines.append('待核实：'+q)
            for h in p['history']: lines.append(f'人工处理 {h["action"]}：{h["note"]}')
            lines.append('')
    for r in s['records'].values():
        if r['status']=='pending': lines.append('尚未分析记录：'+r['row']['编号'])
    return '\n'.join(lines)

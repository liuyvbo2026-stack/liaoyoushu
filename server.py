#!/usr/bin/env python3
"""本地 HTTP 服务；只监听回环地址，密钥始终留在服务端。"""
import argparse
import io
import json
import mimetypes
import os
import secrets
import socket
import urllib.parse
import zipfile
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from agent import Agent, config, public_config
from core import AppError, Store, MAX_FILE, TASK_FIELDS, CHAT_FIELDS, export_csv, change_summary, dump, uid, now, undo_info

ROOT=Path(__file__).resolve().parent

class LocalServer(ThreadingHTTPServer):
    daemon_threads=True
    def __init__(self,address,store):
        super().__init__(address,Handler);self.store=store if isinstance(store,Store) else Store(store);self.agent=Agent(self.store);self.csrf=secrets.token_urlsafe(32)

class Handler(BaseHTTPRequestHandler):
    def log_message(self,*args): pass
    def reply(self,data,status=200,mime='application/json; charset=utf-8',filename=None):
        if isinstance(data,(dict,list)): data=dump(data).encode('utf-8')
        elif isinstance(data,str): data=data.encode('utf-8')
        self.send_response(status)
        self.send_header('Content-Type',mime);self.send_header('Content-Length',str(len(data)))
        self.send_header('Cache-Control','no-store');self.send_header('X-Content-Type-Options','nosniff')
        self.send_header('Referrer-Policy','no-referrer')
        self.send_header('Content-Security-Policy',"default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'")
        if filename: self.send_header('Content-Disposition',"attachment; filename*=UTF-8''"+urllib.parse.quote(filename))
        self.end_headers()
        try: self.wfile.write(data)
        except (BrokenPipeError,ConnectionResetError): pass

    def guard(self,write=False):
        port=self.server.server_address[1]
        allowed=[f'127.0.0.1:{port}',f'localhost:{port}']
        if self.headers.get('Host') not in allowed: raise AppError('仅允许通过本机地址访问。',403)
        origin=self.headers.get('Origin')
        if origin and origin not in ['http://'+h for h in allowed]: raise AppError('不接受来自其他网站的请求。',403)
        if write and self.headers.get('X-CSRF-Token')!=self.server.csrf: raise AppError('页面会话已更新，请刷新后重试。',403)

    def do_GET(self):
        try:
            self.guard();path=urllib.parse.urlparse(self.path).path
            if path=='/api/state':
                s=self.server.store.read();s['runs']=[{k:v for k,v in r.items() if k not in ['messages','raw_output']} for r in s['runs']]
                return self.reply({'state':s,'config':public_config(),'csrf':self.server.csrf,'undo':undo_info(s)})
            if path=='/api/export/table':
                s=self.server.store.read();return self.reply(export_csv(s['headers'],s['tasks']),mime='text/csv; charset=utf-8',filename='聊有数-正式任务表.csv')
            if path=='/api/export/summary':
                return self.reply(change_summary(self.server.store.read()),mime='text/markdown; charset=utf-8',filename='聊有数-变更说明.md')
            if path=='/api/export/backup': return self.reply(self.server.store.backup(),filename='聊有数-进度备份.json')
            if path=='/api/export/bundle':
                backup=self.server.store.backup();s=backup['state'];out=io.BytesIO()
                with zipfile.ZipFile(out,'w',zipfile.ZIP_DEFLATED) as z:
                    z.writestr('聊有数-正式任务表.csv',export_csv(s['headers'],s['tasks']))
                    z.writestr('聊有数-变更说明.md',change_summary(s))
                    z.writestr('聊有数-进度备份.json',dump(backup))
                    z.writestr('继续更新说明.txt','同一电脑会自动恢复。换电脑时，先在聊有数点击“恢复进度”，选择 JSON，再上传新聊天。CSV 不含处理历史，单独导入 CSV 不能恢复跨电脑去重。进度包含聊天原文和模型输出，请按业务资料保存。')
                return self.reply(out.getvalue(),mime='application/zip',filename='聊有数-导出与进度.zip')
            if path.startswith('/api/template/'):
                kind=path.rsplit('/',1)[1]
                if kind not in ['tasks','chat']: raise AppError('模板不存在。',404)
                return self.reply(export_csv(TASK_FIELDS if kind=='tasks' else CHAT_FIELDS,[]),mime='text/csv; charset=utf-8',filename=('任务表' if kind=='tasks' else '聊天记录')+'-模板.csv')
            allowed={'/':'index.html','/app.js':'app.js','/style.css':'style.css','/favicon.svg':'favicon.svg','/review.js':'review.js','/table.js':'table.js','/review.css':'review.css'}
            if path in allowed:
                file=ROOT/'static'/allowed[path]
                return self.reply(file.read_bytes(),mime=(mimetypes.guess_type(file)[0] or 'text/plain')+'; charset=utf-8')
            raise AppError('没有这个页面。',404)
        except AppError as e: self.reply({'error':str(e)},e.status)
        except Exception: self.reply({'error':'读取失败，请稍后重试。'},500)

    def do_POST(self):
        try:
            self.guard(True)
            if not self.headers.get('Content-Type','').startswith('application/json'): raise AppError('请使用 JSON 提交。',415)
            try: size=int(self.headers.get('Content-Length','0'))
            except ValueError: raise AppError('请求长度无效。')
            if size<=0 or size>25*MAX_FILE: raise AppError('请求文件过大或为空，进度备份最多 125MB。',413)
            try: body=json.loads(self.rfile.read(size).decode('utf-8'))
            except (ValueError,UnicodeError): raise AppError('文件不是有效 UTF-8 或 JSON。')
            if not isinstance(body,dict): raise AppError('请求格式不正确。')
            path=urllib.parse.urlparse(self.path).path;store=self.server.store
            if path in ['/api/import/tasks','/api/import/chat']:
                if not isinstance(body.get('content'),str) or len(body['content'].encode('utf-8'))>MAX_FILE: raise AppError('CSV 最大支持 5MB。')
                if path.endswith('tasks'): result=store.import_tasks(body['content'],body.get('filename','任务表.csv'),body.get('new_workspace') is True)
                else: result=store.import_chat(body['content'],body.get('filename','聊天记录.csv'))
            elif path=='/api/analyze': result=self.server.agent.start()
            elif path=='/api/question': result=self.server.agent.start('question',body.get('question',''))
            elif path=='/api/supplement':
                from core import text_value
                content=text_value(body.get('content'),'补充说明',4000,False)
                rid=text_value(body.get('record_id'),'补充记录编号',100,False)
                if not rid.startswith('U-'): raise AppError('补充记录编号无效。')
                result=store.import_chat(export_csv(CHAT_FIELDS,[{'编号':rid,'时间':text_value(body.get('time'),'时间',100,False),'来源':'网页用户补充（仍需核对确认）','内容':content}]),'用户补充说明')
            elif path=='/api/decision': result=store.decide(body.get('id'),body.get('action'),body.get('version'),body.get('changes'),body.get('note',''))
            elif path=='/api/confirm-batch': result=store.confirm_batch(body.get('items'))
            elif path=='/api/undo-confirm': result=store.undo_confirm(body.get('operation_id'))
            elif path=='/api/restore': result=store.restore(body)
            else: raise AppError('操作不存在。',404)
            self.reply(result)
        except AppError as e: self.reply({'error':str(e)},e.status)
        except Exception: self.reply({'error':'操作失败，已保留当前数据。请检查文件格式并重试。'},500)

if __name__=='__main__':
    parser=argparse.ArgumentParser(description='聊有数 · 本地任务更新工作台')
    parser.add_argument('--port',type=int,default=int(config()['port']))
    parser.add_argument('--data-dir',default=str(ROOT/'data'))
    args=parser.parse_args()
    try:
        server=LocalServer(('127.0.0.1',args.port),Path(args.data_dir)/'liaoyoushu.sqlite3')
        print(f'聊有数已启动：http://127.0.0.1:{args.port}  （Ctrl+C 停止）',flush=True)
        server.serve_forever()
    except OSError as e:
        print(f'启动失败，端口可能已占用。可运行 python3 server.py --port {args.port+1}。',flush=True)
        raise SystemExit(1)
    except KeyboardInterrupt: server.server_close()

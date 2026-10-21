"""Start only the v3 processes; keep the legacy service and model store intact."""
from pathlib import Path
import argparse
import json
import os
import shutil
import signal
import socket
import subprocess
import sys
import time
import urllib.request
import webbrowser
from backend.app.gpu import device_label, gpu_environment

ROOT=Path(__file__).resolve().parent


def open_port(port):
    with socket.socket() as sock:
        return sock.connect_ex(('127.0.0.1',port))==0


def find_tool(name):
    """Prefer the bundled Windows binary in tools/, then whatever is on PATH."""
    bundled=ROOT/'tools'/(name+('.exe' if os.name=='nt' else ''))
    return str(bundled) if bundled.is_file() else shutil.which(name)


def find_ollama():
    """Return (executable, models_dir): portable ../.runtime first, then a normal Ollama install."""
    portable=ROOT.parent/'.runtime/ollama'/('ollama.exe' if os.name=='nt' else 'ollama')
    if portable.is_file():
        models=ROOT.parent/'.runtime/models'
        return str(portable),(str(models) if models.is_dir() else None)
    return shutil.which('ollama'),None


def wait_for_port(port,seconds):
    deadline=time.monotonic()+seconds
    while time.monotonic()<deadline:
        if open_port(port):
            return True
        time.sleep(.3)
    return False


def warm_search_model():
    request=urllib.request.Request('http://127.0.0.1:11435/api/embed',
        data=json.dumps({'model':'qwen3-embedding:0.6b','input':'surveillance recording search',
                         'keep_alive':'15m'}).encode(),headers={'Content-Type':'application/json'})
    opener=urllib.request.build_opener(urllib.request.ProxyHandler({}))
    with opener.open(request,timeout=180) as response:
        return bool(json.load(response).get('embeddings'))


def main():
    parser=argparse.ArgumentParser()
    parser.add_argument('--no-browser',action='store_true')
    parser.add_argument('--demo',action='store_true',help='Use the separate public-video AI demo database.')
    args=parser.parse_args()
    if any(open_port(p) for p in (5174,8766,11435)):
        raise SystemExit('A v3 port (5174, 8766 or 11435) is already in use. Close that v3 session first; no existing process was stopped.')
    python=ROOT/'.venv/Scripts/python.exe' if os.name=='nt' else ROOT/'.venv/bin/python'
    if not python.exists():
        raise SystemExit('Prepare the v3 virtual environment first; see README.md.')
    if not (ROOT/'frontend/node_modules/vite/bin/vite.js').exists():
        raise SystemExit('Run npm ci in v3/frontend first.')
    node=shutil.which('node')
    if not node:
        raise SystemExit('Node.js was not found on PATH. Install Node.js 20+ and try again.')
    data=ROOT/('data/ai-demo' if args.demo else 'data')
    logs=data/'logs';logs.mkdir(parents=True,exist_ok=True)
    env=os.environ.copy()
    env.update(gpu_environment())
    print('AI device: '+device_label(),flush=True)
    for name,key in (('ffmpeg','JAGAAI_FFMPEG'),('ffprobe','JAGAAI_FFPROBE')):
        tool=find_tool(name)
        if tool:
            env[key]=tool
        else:
            env.pop(key,None)
    if 'JAGAAI_FFPROBE' not in env:
        print('FFprobe was not found (tools/ or PATH). The demo works; uploading new recordings needs FFmpeg installed.',flush=True)
    env.update({'JAGAAI_DATA_DIR':str(data),'JAGAAI_OLLAMA_URL':'http://127.0.0.1:11435',
                'JAGAAI_YOLOX_MODEL':str(ROOT/'models/yolox_s.onnx'),'PYTHONUTF8':'1'})
    processes=[];handles=[]
    def spawn(name,command,cwd,child_env=env):
        log=(logs/(name+'.log')).open('ab');handles.append(log)
        process=subprocess.Popen(command,cwd=cwd,env=child_env,stdout=log,stderr=subprocess.STDOUT,
                                 creationflags=subprocess.CREATE_NO_WINDOW if os.name=='nt' else 0)
        processes.append(process)
        return process
    try:
        ollama_ready=open_port(11435)
        if not ollama_ready:
            ollama,models=find_ollama()
            if ollama:
                ai_env=env|{'OLLAMA_HOST':'127.0.0.1:11435'}
                if models:
                    ai_env['OLLAMA_MODELS']=models
                spawn('ollama',[ollama,'serve'],ROOT,ai_env)
                ollama_ready=True
            else:
                print('Ollama is not installed (https://ollama.com). Detection still works; semantic search and descriptions will report unavailable.',flush=True)
        api=spawn('api',[str(python),'-m','uvicorn','app.main:app','--host','127.0.0.1','--port','8766'],ROOT/'backend')
        web=spawn('web',[node,'node_modules/vite/bin/vite.js','--host','127.0.0.1','--port','5174','--strictPort'],ROOT/'frontend')
        deadline=time.monotonic()+35
        while time.monotonic()<deadline:
            if any(p.poll() is not None for p in (api,web)):
                raise RuntimeError('A v3 process stopped during startup. See v3/data/logs/.')
            if open_port(5174) and open_port(8766):
                break
            time.sleep(.3)
        else:
            raise RuntimeError('Startup timed out. See v3/data/logs/.')
        print('JagaAI v3: http://127.0.0.1:5174',flush=True)
        print('One sign-in for residents, guards and managers; the account role picks the workspace.',flush=True)
        print('API: http://127.0.0.1:8766/docs',flush=True)
        if args.demo and ollama_ready:
            print('Warming the local search model...',flush=True)
            try:
                if not wait_for_port(11435,30) or not warm_search_model():
                    raise RuntimeError('no embeddings returned')
                print('AI demo search is ready.',flush=True)
            except Exception as error:
                print(f'Semantic search is not ready ({error}). Run: ollama pull qwen3-embedding:0.6b '
                      'and ollama pull qwen3-vl:2b-instruct. Everything else in the demo still works.',flush=True)
        print('Ctrl+C stops only processes started by this launcher. Legacy services are left alone.',flush=True)
        if not args.no_browser:
            webbrowser.open('http://127.0.0.1:5174')
        while all(p.poll() is None for p in (api,web)):
            time.sleep(.5)
    except KeyboardInterrupt:
        print('\nStopping v3 processes...',flush=True)
    finally:
        for process in reversed(processes):
            if process.poll() is None:
                if os.name=='nt':
                    subprocess.run(['taskkill','/PID',str(process.pid),'/T','/F'],
                                   capture_output=True,creationflags=subprocess.CREATE_NO_WINDOW)
                else:
                    process.terminate()
                try:
                    process.wait(timeout=8)
                except subprocess.TimeoutExpired:
                    process.kill()
        for handle in handles:
            handle.close()


if __name__=='__main__':
    main()

"""Build the polling frontend and an allowlisted, credential-free Colab ZIP/notebook."""
import argparse
import csv
from datetime import datetime, timedelta, timezone
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import zipfile

ROOT = Path(__file__).resolve().parents[1]


def sha256(path):
    with Path(path).open("rb") as handle:
        return hashlib.file_digest(handle, "sha256").hexdigest()


def cell(kind, source):
    result = {"cell_type": kind, "metadata": {}, "source": source.splitlines(keepends=True)}
    if kind == "code":
        result.update(execution_count=None, outputs=[])
    return result


def notebook(bundle_hash):
    introduction = """# JagaAI：Colab 临时网站 + 真实 AI

仅用免费 Colab 资源，不设置账单、不绑卡、不调用收费 AI API。网站、Python 后端、YOLOX 检测、Qwen3-VL 描述和 Qwen3 embedding 都在本次 Colab 运行环境里运行。

**这不是长期托管。** Colab 可能提前中断并回收数据；它还限制免费环境主要用于网页界面的用途。首次安装需下载数 GB。临时网址每次重启会变化，不设置保活、自动重连或账号轮换。

1. 在“运行时 → 更改运行时类型”中选免费 T4 GPU；如无免费 GPU，可等待或使用较慢的 CPU，勿升级付费。
2. 下载配套 `JagaAI-Colab.zip`，按顺序运行下面的单元格。
3. 在密码输入框中设置至少 12 字符的演示管理员密码；不要使用 Google 密码。
4. 最后输出的 `https://….trycloudflare.com` 是网站和 AI 共用的公开临时网址。访客仍需网站账号登录。

内置两段公开 MEVA 素材，由本次环境重新分析；不携带原项目数据库、会话、私有录像或预制 AI 结果。原录像时间为 2018 年，搜索时不要选“最近一天”。居民入口采用固定验证码 **246810** 的演示登录，未接真实短信，请仅填演示资料。

默认数据仅保存在本次运行环境。可在第一格启用 Google Drive 备份：需由你授权，只将数据库快照、录像和图片备份到 `MyDrive/JagaAI-Colab`。每两分钟和正常停止时备份一次；突然中断可能丢失最近修改。运行中的 SQLite 不直接放到 Drive 上。

参考：[Colab 限制](https://research.google.com/colaboratory/faq.html)、[临时隧道限制](https://developers.cloudflare.com/tunnel/get-started/quick-tunnels/)。
"""
    upload = f'''#@title 1. 上传启动包（同一次运行环境重跑会复用已上传文件）
BACKUP_TO_GOOGLE_DRIVE = False #@param {{type:"boolean"}}
RESIDENT_DEMO_LOGIN = True #@param {{type:"boolean"}}
ADMIN_EMAIL = "admin@jagaai.local" #@param {{type:"string"}}

from pathlib import Path
import hashlib, json, sys, zipfile
from google.colab import files

BUNDLE_SHA256 = "{bundle_hash}"
BACKUP_DIR = None
archive = Path("/content/JagaAI-Colab.zip")
if BACKUP_TO_GOOGLE_DRIVE:
    from google.colab import drive
    drive.mount("/content/drive")
    BACKUP_DIR = Path("/content/drive/MyDrive/JagaAI-Colab")
    BACKUP_DIR.mkdir(parents=True, exist_ok=True)
    cached = BACKUP_DIR / archive.name
    if not archive.exists() and cached.exists():
        import shutil
        shutil.copy2(cached, archive)

def archive_hash(path):
    with path.open("rb") as handle:
        return hashlib.file_digest(handle, "sha256").hexdigest()

if not archive.exists() or archive_hash(archive) != BUNDLE_SHA256:
    print("请选择配套 JagaAI-Colab.zip；不要上传原项目文件夹或数据库。")
    uploaded = files.upload()
    chosen = next((name for name in uploaded if name.endswith(".zip")), None)
    if not chosen:
        raise RuntimeError("没有选择 ZIP 启动包。")
    archive.write_bytes(uploaded[chosen])
if archive_hash(archive) != BUNDLE_SHA256:
    raise RuntimeError("启动包 SHA-256 不匹配，请使用与此 Notebook 配套的 ZIP。")
source = Path("/content/jagaai-colab")
source.mkdir(exist_ok=True)
with zipfile.ZipFile(archive) as package:
    for entry in package.infolist():
        target = (source / entry.filename).resolve()
        if not target.is_relative_to(source.resolve()):
            raise RuntimeError("启动包含无效路径。")
    package.extractall(source)
if BACKUP_DIR:
    import shutil
    shutil.copy2(archive, BACKUP_DIR / archive.name)
ROOT = source / "v3"
sys.path.insert(0, str(ROOT / "deploy/colab"))
import colab_runtime
print("启动包已校验；原电脑不参与云端分析。")
'''
    install = '''#@title 2. 安装运行环境（首次下载较久，请等待完成）
colab_runtime.install(ROOT)
'''
    password = '''#@title 3. 设置演示管理员密码（输入时隐藏）
from getpass import getpass
ADMIN_PASSWORD = getpass("JagaAI 管理员密码（至少 12 字符，不是 Google 密码）：")
if len(ADMIN_PASSWORD) < 12 or not ADMIN_PASSWORD.strip():
    raise ValueError("请重新运行本格，并设置至少 12 字符的密码。")
print("密码已放入当前会话内存，不会输出或写入启动包。")
'''
    start = '''#@title 4. 启动真实 AI 和公开临时网址（保持本格运行）
if "jagaai_session" in globals() and not jagaai_session.closed:
    jagaai_session.check_children()
    print("继续验证当前会话：" + jagaai_session.url)
else:
    jagaai_session = colab_runtime.ColabSession(
        ROOT, ADMIN_EMAIL, ADMIN_PASSWORD,
        backup_dir=BACKUP_DIR, resident_demo=RESIDENT_DEMO_LOGIN,
    )
    jagaai_session.start()
colab_runtime.ColabSession.verify_application(jagaai_session)
jagaai_session.wait()
'''
    return {"nbformat": 4, "nbformat_minor": 5,
            "metadata": {"accelerator": "GPU", "kernelspec": {"name": "python3", "display_name": "Python 3"},
                         "language_info": {"name": "python"},
                         "colab": {"name": "JagaAI_Colab_Temporary.ipynb", "provenance": [], "private_outputs": True}},
            "cells": [cell("markdown", introduction), cell("code", upload), cell("code", install),
                      cell("code", password), cell("code", start),
                      cell("markdown", """## 断线后手动恢复

- 运行环境仍在：停止旧的启动格，重新运行第 3、4 格。保留相同的管理员邮箱与密码。
- 运行环境被回收：重新运行所有单元格。启用过 Drive 备份时可从快照恢复，否则从独立演示数据重新开始。
- 新临时网址会打印在第 4 格输出中，重新发给访客。旧网址不再有效。
- 登录后等待两段样例完成分析，再使用 Ask JagaAI；也可在 Cameras 上传自己的授权 MP4（单文件不超过 90 MB）。
- 日志在 `/content/jagaai-colab/v3/.runtime-colab/logs/`。分享日志前检查其中的临时网址及业务资料。
- 学校或家中的私有摄像头地址不会自动从 Colab 访问到；现场可用公开样例或上传录像演示。

该 Notebook 只有运行成功并输出网址后才形成临时部署。源码校验和本地测试不代表 Colab GPU、网络隧道已验证。
""")]}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--output", type=Path, default=ROOT / "output/colab")
    parser.add_argument("--skip-build", action="store_true", help="Reuse an unchanged, previously verified Colab frontend build.")
    args = parser.parse_args()
    output = args.output.resolve()
    output.mkdir(parents=True, exist_ok=True)
    if not args.skip_build:
        frontend = ROOT / "frontend"
        subprocess.run(["node", "node_modules/typescript/bin/tsc", "-p", "tsconfig.json", "--noEmit", "--incremental", "false"], cwd=frontend, check=True)
        subprocess.run(["node", "node_modules/vite/bin/vite.js", "build", "--outDir", "dist-colab"],
                       cwd=frontend, env=os.environ | {"VITE_JAGAAI_POLL_UPDATES": "1"}, check=True)
    if not (ROOT / "frontend/dist-colab/index.html").is_file():
        raise RuntimeError("The Colab frontend build is missing.")
    entries = {}
    def add(path, name=None):
        entries[name or "v3/" + path.relative_to(ROOT).as_posix()] = path
    for path in sorted((ROOT / "backend/app").glob("*.py")):
        add(path)
    for path in sorted((ROOT / "backend").glob("requirements*.txt")):
        add(path)
    for path in sorted((ROOT / "frontend/dist-colab").rglob("*")):
        if path.is_file():
            add(path, "v3/frontend/dist/" + path.relative_to(ROOT / "frontend/dist-colab").as_posix())
    for filename in ("colab_runtime.py", "prepare_demo.py", "verify_ai.py", "README.md"):
        add(ROOT / "deploy/colab" / filename)
    for filename in ("yolox_s.onnx", "yolox-s-provenance.json"):
        add(ROOT / "models" / filename)
    for path in sorted((ROOT / "docs/licenses").glob("*.txt")):
        add(path)
    metadata = {row["clip_id"]: row for row in csv.DictReader((ROOT / "data/meva/eval_candidates.csv").open(encoding="utf-8-sig"))}
    cases = json.loads((ROOT / "scripts/ai-demo-cases.json").read_text(encoding="utf-8"))["cases"]
    samples = ROOT / "deploy/colab/samples"
    samples.mkdir(exist_ok=True)
    manifest = []
    for case in cases:
        if case["id"] not in {"stairs-entry", "courtyard-entry"}:
            continue
        source = ROOT / "data/ai-demo/videos" / (case["id"] + ".mp4")
        target = samples / source.name
        shutil.copy2(source, target)
        add(target)
        row = metadata[case["source"]]
        recorded = datetime.fromisoformat(row["upload_recorded_at_myt_for_testing"]).replace(
            tzinfo=timezone(timedelta(hours=8))) + timedelta(seconds=case["from"])
        manifest.append({"id": case["id"], "name": case["name"], "filename": source.name,
                         "line": case["r3_line"], "duration_sec": case["to"] - case["from"],
                         "recorded_at": recorded.isoformat(), "sha256": sha256(source),
                         "source_url": "https://mevadata-public-01.s3.amazonaws.com/" + row["s3_key"],
                         "license": "CC-BY-4.0", "attribution": "MEVA, Kitware Inc. and IARPA; https://mevadata.org/",
                         "modifications": "Excerpted and resized; R3 demo boundary enabled all day. Original source date preserved."})
    (samples / "manifest.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=2), encoding="utf-8")
    add(samples / "manifest.json")
    bundle_manifest = {name: {"sha256": sha256(path), "bytes": path.stat().st_size} for name, path in sorted(entries.items())}
    archive = output / "JagaAI-Colab.zip"
    partial = archive.with_suffix(".partial")
    with zipfile.ZipFile(partial, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=6) as package:
        for name, path in sorted(entries.items()):
            package.write(path, name)
        package.writestr("BUNDLE-MANIFEST.json", json.dumps(bundle_manifest, indent=2))
    partial.replace(archive)
    content = json.dumps(notebook(sha256(archive)), ensure_ascii=False, indent=1)
    notebook_path = ROOT / "notebooks/JagaAI_Colab_Temporary.ipynb"
    notebook_path.write_text(content, encoding="utf-8")
    (output / notebook_path.name).write_text(content, encoding="utf-8")
    (output / "SHA256SUMS.txt").write_text(sha256(archive) + "  " + archive.name + "\n", encoding="utf-8")
    shutil.copy2(ROOT / "deploy/colab/README.md", output / "START-HERE.md")
    print(json.dumps({"archive": str(archive), "bytes": archive.stat().st_size, "sha256": sha256(archive),
                      "notebook": str(output / notebook_path.name), "files": len(entries)}, ensure_ascii=False))


if __name__ == "__main__":
    main()

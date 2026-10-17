"""Prepare explicit local dependencies; never opens the legacy application's .env."""
from pathlib import Path
import base64
import hashlib
import json
import shutil
import sqlite3
import urllib.request
import zipfile
from datetime import datetime, timezone

ROOT = Path(__file__).resolve().parents[1]
LEGACY = ROOT.parent
stamp = datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%SZ')
backup = LEGACY.parent / 'backups' / ('jagaai-before-v3-' + stamp)
backup.mkdir(parents=True, exist_ok=False)
with zipfile.ZipFile(backup / 'legacy-source.zip', 'w', zipfile.ZIP_DEFLATED) as archive:
    for folder in ['apps', 'packages', 'scripts', 'tests', 'docs']:
        for path in (LEGACY / folder).rglob('*'):
            if path.is_file():
                archive.write(path, path.relative_to(LEGACY))
    for path in LEGACY.iterdir():
        if path.is_file():
            archive.write(path, path.name)
db = LEGACY / 'data' / 'jagaai.sqlite'
if db.exists():
    with sqlite3.connect(f'file:{db.as_posix()}?mode=ro', uri=True) as source:
        with sqlite3.connect(backup / 'legacy.sqlite') as destination:
            source.backup(destination)
            assert destination.execute('PRAGMA integrity_check').fetchone()[0] == 'ok'
manifest = {'created_at': stamp, 'source_archive': 'legacy-source.zip',
            'database_backup': 'legacy.sqlite' if db.exists() else None,
            'media_preserved_in_place': str(LEGACY / 'data'),
            'models_preserved_in_place': str(LEGACY / '.runtime'),
            'old_files_deleted': False}
(backup / 'manifest.json').write_text(json.dumps(manifest, indent=2), encoding='utf-8')
(ROOT / 'docs' / 'legacy-backup.json').write_text(json.dumps(manifest | {'backup_directory': str(backup)}, indent=2), encoding='utf-8')
tools = ROOT / 'tools'
tools.mkdir(exist_ok=True)
for source, target in [
    (LEGACY / 'node_modules/ffmpeg-static/ffmpeg.exe', tools / 'ffmpeg.exe'),
    (LEGACY / 'node_modules/ffprobe-static/bin/win32/x64/ffprobe.exe', tools / 'ffprobe.exe'),
]:
    if source.exists() and not target.exists():
        shutil.copy2(source, target)
models = ROOT / 'models'
models.mkdir(exist_ok=True)
url = 'https://github.com/Megvii-BaseDetection/YOLOX/releases/download/0.1.1rc0/yolox_s.onnx'
target = models / 'yolox_s.onnx'
if not target.exists():
    temporary = target.with_suffix('.download')
    urllib.request.urlretrieve(url, temporary)
    if temporary.stat().st_size < 1_000_000:
        raise RuntimeError('Downloaded YOLOX file is unexpectedly small; it was not installed.')
    temporary.replace(target)
licenses = ROOT / 'docs' / 'licenses'
licenses.mkdir(exist_ok=True)
for filename, address in [
    ('YOLOX-Apache-2.0.txt', 'https://raw.githubusercontent.com/Megvii-BaseDetection/YOLOX/main/LICENSE'),
    ('supervision-MIT.txt', 'https://raw.githubusercontent.com/roboflow/supervision/0.25.1/LICENSE.md'),
]:
    try:
        urllib.request.urlretrieve(address, licenses / filename)
    except Exception as error:
        print(f'License retrieval needs follow-up: {filename}: {error}')
provenance = {'model': 'YOLOX-S', 'release': '0.1.1rc0', 'source': url,
              'upstream_docs': 'https://github.com/Megvii-BaseDetection/YOLOX/tree/main/demo/ONNXRuntime',
              'sha256_observed': hashlib.file_digest(target.open('rb'), 'sha256').hexdigest(),
              'checksum_note': 'Observed local digest, not an independently published upstream checksum.',
              'size_bytes': target.stat().st_size, 'license': 'Apache-2.0'}
(models / 'provenance.json').write_text(json.dumps(provenance, indent=2), encoding='utf-8')
print('Legacy source and online SQLite backup verified:', backup)
print('YOLOX-Tiny installed:', provenance['size_bytes'], 'bytes')

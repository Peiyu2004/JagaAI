# JagaAI v3

Local security command centre for property management. Plan: `../../JagaAI_Redesign_Plan_v3.md`. Legacy app in `../` is untouched.

## Quick start for judges (Windows 10/11, 3 steps)

Needs **Python 3.12**, **Node.js 20+** (tested on 24) and, for AI search, **[Ollama](https://ollama.com)**. An NVIDIA GPU is optional: the launcher uses any NVIDIA CUDA card it finds and otherwise runs detection on the CPU (slower, same results).

1. **Install dependencies** (in `jagaai\v3`, first run only, takes a few minutes):
   ```
   py -3.12 -m venv .venv
   .venv\Scripts\pip install -r backend\requirements.txt -r backend\requirements-vision.txt
   cd frontend && npm ci && cd ..
   ```
2. **Pull the local AI models** (optional; about 2.5 GB; without them detection and alerts still work, semantic search and descriptions show as unavailable):
   ```
   ollama pull qwen3-embedding:0.6b
   ollama pull qwen3-vl:2b-instruct
   ```
3. **Double-click `Start-AI-Demo.cmd`** for the prepared demo with seven analysed public clips, or `Start-V3.cmd` for an empty workspace. The browser opens http://127.0.0.1:5174.

Sign in as **`admin@jagaai.local`** / **`JagaAI-demo-2026!`** (also `supervisor@jagaai.local`, same password). The resident page is http://127.0.0.1:5174/resident. These are local demo accounts; change them before any real use.

Uploading *new* recordings needs FFprobe: install FFmpeg (`winget install Gyan.FFmpeg`) or copy `ffmpeg.exe`/`ffprobe.exe` into `tools\`. The prepared demo does not need it.

## Run details

Ports: web 5174, API 8766, Ollama 11435 (a dedicated v3 server), all loopback only. The launcher refuses to start if 5174, 8766 or 11435 is taken and stops only what it started. Logs: `data/logs/` (or `data/ai-demo/logs/` for the demo).

GPU selection: the launcher picks the first NVIDIA GPU reported by `nvidia-smi` and pins it by UUID; AMD ROCm and Vulkan are then disabled for its child processes so Ollama cannot fall back to an integrated GPU. If CUDA cannot start, detection logs a warning and uses the CPU. Set `JAGAAI_GPU=RTX 3050` to prefer a specific card or `JAGAAI_DEVICE=cpu` to force CPU. Ollama: the portable copy in `../.runtime/` is used when present, otherwise the installed `ollama` on PATH.

See `docs/ai-demo.md` for the demo scenarios, limits and repeatable evaluation.

## Rebuild the environment

```
python -m venv .venv
.venv\Scripts\pip install -r backend\requirements.txt -r backend\requirements-vision.txt
cd frontend && npm ci
```

`models/yolox_s.onnx` (Apache-2.0) is committed; `tools/ffmpeg.exe` and `tools/ffprobe.exe` are not (see above). Sources and licences are in `models/yolox-s-provenance.json` and `docs/licenses/`.

## Tests

```
cd backend && ..\.venv\Scripts\python.exe -m pytest -q
cd frontend && node node_modules/typescript/bin/tsc -b
.venv\Scripts\python.exe scripts\smoke-pipeline.py   # needs API + Ollama running
```

## Public evaluation clips (MEVA, CC BY 4.0)

`scripts/meva_select.py` picks annotated MEVA clips and writes a labelling sheet. Nothing is downloaded without `--yes`.

```
.venv\Scripts\python.exe scripts\meva_select.py index                 # list the public bucket only
.venv\Scripts\python.exe scripts\meva_select.py annotations [--yes]   # 128 small YAML files, 47 KB
.venv\Scripts\python.exe scripts\meva_select.py plan                  # data/meva/eval_candidates.csv + eval_protocol.md
.venv\Scripts\python.exe scripts\meva_select.py download [--yes]      # AVI clips, prints total GB first
.venv\Scripts\python.exe scripts\meva_select.py to-mp4                # the upload form needs MP4
```

Downloads are slow from this network (about 150-280 KB/s, hours for 3.4 GB). `data/meva/run-download.cmd` runs download, then MP4 conversion, detached; it resumes by skipping finished files. Uploaded recordings are queued for analysis automatically; set `JAGAAI_ENABLE_VLM=0` on the API process to skip the slow VLM descriptions during rules-only evaluation.

**Labelling the 24 clips:** double-click `Label-MEVA.cmd` (or `.venv\Scripts\python.exe scripts\label_server.py`). A page opens at http://127.0.0.1:8780 with the video on the left and the form on the right. Labels save after every change to `data/meva/labels.json`; **Export CSV** writes `data/meva/eval_labelled_<your name>.csv`. The server answers only to 127.0.0.1 and loads nothing from the internet.

MEVA has no loitering or restricted-area labels, so R1/R3 ground truth comes from a person watching each clip (see the generated protocol). It is daylight US footage with no usable night slot, so it cannot test the 19:00-06:00 window.

## Status

The RTX 3050 AI demo and repeatable checks are documented in `docs/ai-demo.md`; current results are in `output/ai-readiness/`. These engineering scenarios do not establish deployment accuracy; independent R1 positive labels and night testing remain outstanding. See `docs/acceptance.md` (checklist plus dated verification log). Colab/MEVA training notes: `docs/training/README.md`, notebook `notebooks/JagaAI_MEVA_QLoRA.ipynb`.

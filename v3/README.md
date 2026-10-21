# JagaAI v3

Local security command centre for property management. This is the current JagaAI submission; the earlier prototype is in the repository root.

Staff work in a desktop workstation: a 3D command centre built from the site's zones, alert review, incidents, Ask JagaAI search, cameras, rules, insights, tasks and accounts. Residents get a phone-first app with a three-step report on a map of the estate, report progress, community activities and points. The 3D scene and the flat estate map share one layout (`frontend/src/components/town/layout.ts`), so a zone sits in the same place on both. Endpoints and roles are listed in [the API contract](docs/api-contract.md).

## One-click start (Windows 10/11 x64)

From the repository root, double-click **`Start-JagaAI.cmd`**. It installs missing Python 3.12, Node.js 24, Python/npm dependencies, FFmpeg and local Ollama models, then opens the prepared demo at **http://127.0.0.1:5174**. No administrator account or manual PATH configuration is needed. Internet access and sufficient disk space are needed for the first setup; allow at least 12 GB, with additional room for NVIDIA dependencies and recordings.

Later runs reuse the installation. `Start-AI-Demo.cmd` in this folder uses the same installer; `Start-V3.cmd` selects the separate workspace instead of the prepared demo. Keep the terminal open while using JagaAI, and press Ctrl+C to stop it.

From a terminal in the repository root, use `.\Start-JagaAI.cmd -SkipAI` to skip Ollama/model downloads, or `.\Setup-JagaAI.cmd` to install without starting the app. `-Empty` selects the separate workspace and `-NoBrowser` suppresses browser launch. Without the models, detection and alerts still work; semantic search and descriptions are unavailable. Existing models are reused when present.

Setup logs are in `../.runtime/setup/setup.log`. See [the root README](../README.md) for download sizes, troubleshooting and the installation details.

Everyone uses the same sign-in page; the account's role decides what opens. Demo accounts, all with password **`JagaAI-demo-2026!`**: `resident@jagaai.local`, `guard@jagaai.local`, `manager@jagaai.local` and `admin@jagaai.local`. Residents can also register on the sign-in page and wait for a manager's approval. These are local demo accounts; change them before any real use.

The automatic installer includes FFmpeg/FFprobe for new uploads. An NVIDIA GPU is optional: the installer chooses CPU dependencies on other computers, and detection falls back to the CPU if CUDA cannot initialise.

## Manual installation

For an existing development environment, install **Python 3.12**, **Node.js 24.11+ within 24.x**, and optionally **[Ollama](https://ollama.com)**. In PowerShell, from `v3/`:

```powershell
py -3.12 -m venv .venv
# CPU installation (no NVIDIA GPU required):
.\.venv\Scripts\python.exe -m pip install -r backend\requirements-cpu.txt
# For NVIDIA CUDA, use requirements-vision.txt instead of requirements-cpu.txt.
cd frontend
npm ci --include=dev
cd ..
```

For AI search, run `ollama pull qwen3-embedding:0.6b` and `ollama pull qwen3-vl:2b-instruct`. If a legacy portable Ollama exists in `../.runtime/ollama`, the launcher uses its `../.runtime/models` store; use the one-click installer to populate that store automatically.

Run `.\.venv\Scripts\python.exe run.py --demo` to use the prepared demo, or omit `--demo` for the separate workspace. New uploads require FFprobe: install FFmpeg (`winget install Gyan.FFmpeg`) or place `ffmpeg.exe` and `ffprobe.exe` in `tools/`. The prepared demo does not require FFprobe. macOS/Linux developers must use their platform's Python, Node.js, Ollama and FFmpeg installations; the one-click `.cmd` launcher targets Windows x64 only.

## Guard notifications

Settings → Notifications configures WhatsApp, automatic calls, SMS backup and guard acceptance records. It starts in **Simulation** with automatic sending disabled. Open an alert and choose **Simulate notification** to exercise the guard's mobile acceptance page. Real delivery requires a configured Twilio account, approved WhatsApp template, consenting contacts and public HTTPS hosting; it has not been verified with a real phone. See [setup and acceptance guide](docs/guard-notifications.md).

## Run details

Ports: web 5174, API 8766, Ollama 11435 (a dedicated v3 server), all loopback only. The launcher refuses to start if 5174, 8766 or 11435 is taken and stops only what it started. Logs: `data/logs/` (or `data/ai-demo/logs/` for the demo).

GPU selection: the launcher picks the first NVIDIA GPU reported by `nvidia-smi` and pins it by UUID; AMD ROCm and Vulkan are then disabled for its child processes so Ollama cannot fall back to an integrated GPU. If CUDA cannot start, detection logs a warning and uses the CPU. Set `JAGAAI_GPU=RTX 3050` to prefer a specific card or `JAGAAI_DEVICE=cpu` to force CPU. Ollama: the portable copy in `../.runtime/` is used when present, otherwise the installed `ollama` on PATH.

See `docs/ai-demo.md` for the demo scenarios, limits and repeatable evaluation.

See [the 2026-10-18 quality verification](docs/quality-verification-20261018.md) for P1/P2 regression coverage and live Chinese, English and Malay semantic-search results.

See [the P3 performance follow-up](docs/p3-performance-20261018.md) for page loading, stylesheet cleanup, the private-app indexing policy and the final before/after measurements.

## Temporary online demo (Google Colab)

`deploy/colab/` and `notebooks/JagaAI_Colab_Temporary.ipynb` run the same website, API and local models in one free Colab runtime behind a Cloudflare Quick Tunnel. Colab can stop at any time and the address changes on every start, so this is for short demos only. See [the Colab guide](deploy/colab/README.md) (in Chinese) and [the hosting options review](docs/cloud-deployment-options-20261017.md).

## Rebuild the environment

Close JagaAI and rerun `../Setup-JagaAI.cmd`. Changed requirements and npm lock files are detected automatically. To replace a broken virtual environment, rename `.venv` to `.venv.old` first; runtime data is stored separately. For manual rebuilding, follow the manual installation steps above.

`models/yolox_s.onnx` (Apache-2.0) is committed; `tools/ffmpeg.exe` and `tools/ffprobe.exe` are not (see above). Sources and licences are in `models/yolox-s-provenance.json` and `docs/licenses/`.

## Tests

For the one-off guard call rehearsal, double-click `Start-Guard-Voice-Demo.cmd` and open `http://127.0.0.1:8767`. It uses isolated synthetic alerts, disables real outbound requests, and supports alert questions, spoken-text acceptance, keypad fallback and a 90-second limit. See [the voice demo and phone setup guide](docs/guard-voice-demo.md).

```powershell
# Run each block from v3/.
cd backend
..\.venv\Scripts\python.exe -m pytest -q
cd ..
cd frontend
npm run build
cd ..
.\.venv\Scripts\python.exe scripts\smoke-pipeline.py   # needs API + Ollama running
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

The RTX 3050 AI demo and repeatable checks are documented in `docs/ai-demo.md`; current results are in `output/ai-readiness/`. These engineering scenarios do not establish deployment accuracy; independent R1 positive labels and night testing remain outstanding. See `docs/acceptance.md` (checklist plus dated verification log). Live cameras: Cameras → Live input accepts an RTSP/HTTP stream or replays an uploaded recording as a simulated camera; segments feed the same analysis queue (see `docs/ai-demo.md`). It has been tested with simulated and local HTTP streams, not yet with a physical RTSP camera. Colab/MEVA training notes: `docs/training/README.md`, notebook `notebooks/JagaAI_MEVA_QLoRA.ipynb`.

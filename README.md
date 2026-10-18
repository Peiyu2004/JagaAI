# JagaAI

JagaAI is a local community safety and property management prototype. The current submission is **JagaAI v3**, with video detection, incident review, resident reports and local AI video search.

## One-click start on Windows

1. Clone this repository, or download and extract its ZIP file.
2. Double-click **`Start-JagaAI.cmd`** in the repository root.
3. Wait for setup. Your browser opens **http://127.0.0.1:5174** with the prepared v3 demo.

**No manual Python, Node.js, FFmpeg or Ollama installation is needed.** The launcher supports **Windows 10/11 x64**, installs missing tools locally, and does not need administrator privileges or permanent PATH changes. Keep the launcher window open; press **Ctrl+C** to stop the app.

The first run needs internet access. The portable Ollama archive is about **1.5 GB** and the AI models need roughly **2.5 GB**. Python packages, extracted tools and caches need additional space; NVIDIA installations also download CUDA/cuDNN dependencies. Allow at least **12 GB free**, plus space for recordings. The terminal shows download progress.

Use the same launcher on later runs. It reuses installed tools and models and detects changes to requirements and npm lock files.

### Demo accounts

| Role | Email | Password |
| --- | --- | --- |
| Administrator | `admin@jagaai.local` | `JagaAI-demo-2026!` |
| Supervisor | `supervisor@jagaai.local` | `JagaAI-demo-2026!` |

Resident entry: **http://127.0.0.1:5174/resident**. These are local demo accounts; change them before real use.

### Launch options

Run these commands in PowerShell from the repository root:

```powershell
# Install everything without starting the app.
.\Setup-JagaAI.cmd

# Skip Ollama and model downloads; start the rest of the demo.
.\Start-JagaAI.cmd -SkipAI

# Use the separate workspace instead of the prepared demo.
.\Start-JagaAI.cmd -Empty

# Start without opening a browser.
.\Start-JagaAI.cmd -NoBrowser
```

Without AI models, detection and alerts still work; semantic search and descriptions are unavailable. `-SkipAI` skips AI installation and can still use existing local models. Rerun without it to add the models later.

The existing `v3/Start-AI-Demo.cmd` and `v3/Start-V3.cmd` use this installer too. `Start-V3.cmd` selects the separate workspace and preserves existing data there.

## What setup installs

- Node.js 24, reusing a compatible installation or downloading a portable copy.
- Python 3.12 in `v3/.venv`, using a local [uv-managed distribution](https://docs.astral.sh/uv/guides/install-python/) if needed.
- Python detection dependencies, choosing CUDA for an NVIDIA GPU and CPU otherwise. A GPU is optional.
- Root and v3 frontend npm dependencies, including development dependencies. This fixes the root `Cannot find type definition file for 'node'` editor error after cloning.
- FFmpeg and FFprobe, copied from the installed npm packages into `v3/tools`.
- Existing Ollama or the [official portable Windows build](https://docs.ollama.com/windows), plus `qwen3-embedding:0.6b` and `qwen3-vl:2b-instruct`.

Portable Node.js, uv and Ollama archives are verified against pinned SHA-256 digests. Tools, caches and setup logs live under `.runtime/`, outside Git. Dependencies are installed inside the project. Existing databases, recordings and accounts are preserved.

## Troubleshooting

| Problem | What to do |
| --- | --- |
| Installation or download failed | Check the terminal and `.runtime/setup/setup.log`, fix the connection or disk-space issue, and rerun. Completed steps are reused. |
| AI downloads are blocked or too large | Run `.\Start-JagaAI.cmd -SkipAI`; rerun without that option to add AI later. |
| Ports 5174, 8766 or 11435 are busy | Close the existing JagaAI session and retry. The launcher does not stop unrelated processes. |
| VS Code still cannot find Node.js types | Complete setup, then reopen VS Code. Root and v3 frontend dependencies are separate. |
| Old or broken `v3/.venv` | Close JagaAI, rename that folder to `.venv.old`, then rerun. Your data is stored separately. |
| API startup failed | Read `v3/data/ai-demo/logs/api.log` for the demo, or `v3/data/logs/api.log` for the separate workspace. |

For support, share the last 20 lines of the terminal error and the relevant log, excluding private data and credentials.

## Project layout

| Location | Purpose |
| --- | --- |
| `Start-JagaAI.cmd` | Automatic setup and v3 demo launch |
| `Setup-JagaAI.cmd` | Setup without launching |
| `scripts/start-jagaai.ps1` | Windows installer implementation |
| `v3/frontend`, `v3/backend` | Current React frontend and Python API |
| `v3/models` | Committed YOLOX-S detector and provenance |
| `v3/data/ai-demo` | Prepared demo using public MEVA clips |
| `apps`, `packages` | Earlier Node.js prototype |

See [the v3 README](v3/README.md) for manual setup, tests and evaluation tooling, [AI demo notes](v3/docs/ai-demo.md) for scenarios and limitations, and [acceptance notes](v3/docs/acceptance.md) for verification status.

Application inference uses local services. The demo uses public MEVA material; engineering checks do not establish accuracy on deployment footage. Runtime data, `.env`, virtual environments and downloaded models are excluded from Git. The launcher prepares each computer's environment after cloning.

## Earlier prototype

The root `package.json`, `Start-Local.cmd` and `Start-Local.ps1` belong to the earlier prototype on **port 5173**. The current v3 submission uses **port 5174**.

To develop the earlier prototype, use Node.js 24.11 or newer within 24.x, run `npm ci --include=dev`, copy `.env.example` to `.env` if needed, then run `npm run ai:setup` and `npm run dev`. The earlier workflow documentation remains in [`docs/`](docs/).

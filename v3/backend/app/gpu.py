"""Pick an NVIDIA CUDA GPU when one exists; otherwise run AI on the CPU.

Set JAGAAI_DEVICE=cpu to skip the GPU, or JAGAAI_GPU=<name fragment> (for example
"RTX 3050") to prefer a specific card. AMD ROCm/Vulkan stay disabled whenever an
NVIDIA card is used so Ollama cannot pick an integrated GPU instead.
"""
import csv
import io
import os
import subprocess
from functools import lru_cache


@lru_cache(maxsize=1)
def selected_gpu():
    """Return {'name', 'uuid'} for the chosen NVIDIA GPU, or None for CPU mode."""
    if os.environ.get('JAGAAI_DEVICE', '').strip().lower() == 'cpu':
        return None
    try:
        result = subprocess.run(
            ['nvidia-smi', '--query-gpu=name,uuid', '--format=csv,noheader'],
            capture_output=True, text=True, check=True, timeout=10,
            creationflags=subprocess.CREATE_NO_WINDOW if os.name == 'nt' else 0)
        gpus = [{'name': row[0].strip(), 'uuid': row[1].strip()}
                for row in csv.reader(io.StringIO(result.stdout), skipinitialspace=True) if len(row) >= 2]
    except (OSError, subprocess.SubprocessError, ValueError):
        return None
    if not gpus:
        return None
    preferred = os.environ.get('JAGAAI_GPU', '').strip().lower()
    for gpu in gpus:
        if preferred and preferred in gpu['name'].lower():
            return gpu
    return gpus[0]


def device_label():
    gpu = selected_gpu()
    return gpu['name'] + ' (CUDA)' if gpu else 'CPU (no NVIDIA CUDA GPU found)'


def gpu_environment():
    env = {'OLLAMA_NO_CLOUD': '1', 'OLLAMA_MAX_LOADED_MODELS': '1', 'OLLAMA_NUM_PARALLEL': '1'}
    gpu = selected_gpu()
    if gpu:
        env.update({'CUDA_VISIBLE_DEVICES': gpu['uuid'],
                    'HIP_VISIBLE_DEVICES': '-1', 'ROCR_VISIBLE_DEVICES': '-1',
                    'OLLAMA_VULKAN': 'false', 'OLLAMA_IGPU_ENABLE': 'false'})
    return env

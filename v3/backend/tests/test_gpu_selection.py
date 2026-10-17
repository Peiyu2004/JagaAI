import subprocess
from app import gpu


def fake_smi(monkeypatch, output):
    gpu.selected_gpu.cache_clear()
    monkeypatch.setattr(gpu.subprocess, 'run', lambda *a, **k: subprocess.CompletedProcess(a, 0, output, ''))


def test_any_nvidia_gpu_is_selected_and_amd_backends_are_disabled(monkeypatch):
    monkeypatch.delenv('JAGAAI_GPU', raising=False)
    monkeypatch.delenv('JAGAAI_DEVICE', raising=False)
    fake_smi(monkeypatch, 'NVIDIA GeForce RTX 4060, GPU-first\n')
    env = gpu.gpu_environment()
    assert env['CUDA_VISIBLE_DEVICES'] == 'GPU-first'
    assert env['HIP_VISIBLE_DEVICES'] == env['ROCR_VISIBLE_DEVICES'] == '-1'
    assert env['OLLAMA_VULKAN'] == env['OLLAMA_IGPU_ENABLE'] == 'false'
    gpu.selected_gpu.cache_clear()


def test_preferred_gpu_name_wins(monkeypatch):
    monkeypatch.setenv('JAGAAI_GPU', 'rtx 3050')
    monkeypatch.delenv('JAGAAI_DEVICE', raising=False)
    fake_smi(monkeypatch, 'NVIDIA GeForce RTX 4090, GPU-other\nNVIDIA GeForce RTX 3050 Laptop GPU, GPU-target\n')
    assert gpu.gpu_environment()['CUDA_VISIBLE_DEVICES'] == 'GPU-target'
    gpu.selected_gpu.cache_clear()


def test_no_nvidia_gpu_falls_back_to_cpu(monkeypatch):
    monkeypatch.delenv('JAGAAI_DEVICE', raising=False)
    gpu.selected_gpu.cache_clear()
    def missing(*a, **k):
        raise FileNotFoundError('nvidia-smi')
    monkeypatch.setattr(gpu.subprocess, 'run', missing)
    assert gpu.selected_gpu() is None
    assert 'CPU' in gpu.device_label()
    assert 'CUDA_VISIBLE_DEVICES' not in gpu.gpu_environment()
    gpu.selected_gpu.cache_clear()


def test_cpu_can_be_forced(monkeypatch):
    monkeypatch.setenv('JAGAAI_DEVICE', 'cpu')
    fake_smi(monkeypatch, 'NVIDIA GeForce RTX 3050 Laptop GPU, GPU-target\n')
    assert gpu.selected_gpu() is None
    gpu.selected_gpu.cache_clear()

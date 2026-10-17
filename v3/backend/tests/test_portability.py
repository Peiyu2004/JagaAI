"""The prepared demo and uploads must work from any folder on another machine."""
from pathlib import Path

import pytest
from fastapi import HTTPException

from app import main, retention


def test_relative_video_paths_resolve_inside_the_data_directory(tmp_path, monkeypatch):
    monkeypatch.setattr(retention, 'DATA_DIR', tmp_path)
    assert retention.media_path('videos/demo.mp4') == tmp_path / 'videos' / 'demo.mp4'
    assert retention.private_path('videos/demo.mp4') == (tmp_path / 'videos' / 'demo.mp4').resolve()
    with pytest.raises(ValueError):
        retention.private_path('../outside.mp4')


def test_missing_configured_ffprobe_falls_back_to_path(tmp_path, monkeypatch):
    system = tmp_path / 'ffprobe.exe'
    system.write_bytes(b'')
    monkeypatch.setenv('JAGAAI_FFPROBE', str(tmp_path / 'missing' / 'ffprobe.exe'))
    monkeypatch.setattr(main.Path, 'is_file', lambda self: self == system)
    monkeypatch.setattr(main.shutil, 'which', lambda name: str(system))
    assert main.ffprobe_path() == str(system)


def test_no_ffprobe_anywhere_is_a_clear_503(tmp_path, monkeypatch):
    monkeypatch.setenv('JAGAAI_FFPROBE', str(tmp_path / 'missing.exe'))
    monkeypatch.setattr(main.Path, 'is_file', lambda self: False)
    monkeypatch.setattr(main.shutil, 'which', lambda name: None)
    with pytest.raises(HTTPException) as error:
        main.ffprobe_path()
    assert error.value.status_code == 503

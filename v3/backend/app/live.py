"""Pull camera streams into fixed-length recordings that the normal analysis queue processes.

Each enabled camera gets one FFmpeg process that writes H.264 MP4 segments (default 60 s).
A finished segment becomes an ordinary Video, so playback, alerts, search and retention
work unchanged. Alerts therefore arrive about one segment plus analysis time after the
moment, not instantly. Consecutive segments keep tracking and rule state (see worker.py).

Sources: rtsp:// rtsps:// http:// https:// from a camera or NVR, or demo:<video id>, which
replays an existing recording in real time as a simulated camera for demonstrations.
"""
import csv
import logging
import os
import shutil
import subprocess
import threading
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path
from urllib.parse import urlsplit, urlunsplit

from sqlmodel import select

from .database import DATA_DIR, session_scope
from .models import AppSettings, Camera, Video, uid, utcnow
from .realtime import publish_refresh

log = logging.getLogger(__name__)
SCHEMES = {'rtsp', 'rtsps', 'http', 'https'}
SEGMENT_CHOICES = (30, 60, 120, 300)
# Segments waiting for analysis per camera before new ones are kept but not analysed.
MAX_BACKLOG = int(os.environ.get('JAGAAI_LIVE_MAX_BACKLOG', '3'))
_recorders = {}
_lock = threading.Lock()


def mask_url(url):
    """Hide the password in rtsp://user:password@host/... before it leaves the server."""
    if not url or url.startswith('demo:'):
        return url
    parts = urlsplit(url)
    if parts.password is None:
        return url
    host = parts.hostname or ''
    if parts.port:
        host += f':{parts.port}'
    return urlunsplit((parts.scheme, f'{parts.username}:***@{host}', parts.path, parts.query, parts.fragment))


def validate_source(url):
    """Return an error message for an unusable source, or None."""
    if url.startswith('demo:'):
        with session_scope() as session:
            video = session.get(Video, url[5:])
            if not video or video.source != 'upload':
                return 'Choose an existing uploaded recording to simulate a camera.'
        return None
    parts = urlsplit(url)
    if parts.scheme not in SCHEMES or not parts.hostname:
        return 'Use an rtsp://, rtsps://, http:// or https:// camera address.'
    if any(c in url for c in '\r\n '):
        return 'The camera address cannot contain spaces or line breaks.'
    return None


def explain(line):
    """Turn the last FFmpeg error line into something a property manager can act on."""
    text = line.lower()
    for needles, message in (
        (('401', 'unauthorized', 'authorization'), 'The camera rejected the user name or password.'),
        (('404', 'not found', 'no such file'), 'The camera answered, but this stream path does not exist.'),
        (('-138', '-10061', 'connection refused'), 'Cannot connect: the connection was refused. Check the address, port and that the camera is on.'),
        (('timed out', 'timeout', '-10060', '-110'), 'The camera did not respond. Check the network and the address.'),
        (('name or service', 'resolve', 'getaddrinfo', '-11001'), 'The camera address could not be found on the network.'),
        (('invalid data', 'could not find codec', 'unsupported'), "Connected, but the stream format could not be read. Try the camera's H.264 sub-stream."),
    ):
        if any(needle in text for needle in needles):
            return message
    return 'Stream stopped: ' + line

def ffmpeg_path():
    bundled = Path(__file__).resolve().parents[2] / 'tools' / ('ffmpeg.exe' if os.name == 'nt' else 'ffmpeg')
    for candidate in (os.environ.get('JAGAAI_FFMPEG'), str(bundled), shutil.which('ffmpeg')):
        if candidate and Path(candidate).is_file():
            return candidate
    return None


def input_args(url):
    if url.startswith('demo:'):
        from .retention import media_path
        with session_scope() as session:
            video = session.get(Video, url[5:])
            path = media_path(video.path) if video else None
        if not path or not path.is_file():
            raise RuntimeError('The recording used for the simulated camera is no longer available.')
        # -re paces the file at its own frame rate, like a camera; -stream_loop repeats it.
        return ['-protocol_whitelist', 'file', '-re', '-stream_loop', '-1', '-i', str(path)]
    scheme = urlsplit(url).scheme
    args = ['-protocol_whitelist', 'rtsp,rtsps,rtp,udp,tcp,tls,http,https,crypto,httpproxy']
    if scheme in {'rtsp', 'rtsps'}:
        args += ['-rtsp_transport', 'tcp', '-timeout', '10000000']
    else:
        args += ['-rw_timeout', '10000000']
    return args + ['-i', url]


def segment_command(ffmpeg, url, folder, seconds):
    return [ffmpeg, '-hide_banner', '-loglevel', 'error', '-nostdin', *input_args(url), '-map', '0:v:0', '-an',
            # Browsers play H.264 only; 1280 px wide keeps CPU and disk use near a camera sub-stream.
            '-vf', "scale='min(1280,iw)':-2", '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23', '-pix_fmt', 'yuv420p',
            '-force_key_frames', f'expr:gte(t,n_forced*{seconds})', '-f', 'segment', '-segment_time', str(seconds),
            '-reset_timestamps', '1', '-segment_format_options', 'movflags=+faststart',
            '-segment_list', str(folder / 'segments.csv'), '-segment_list_type', 'csv', str(folder / 'segment-%06d.mp4')]


class Recorder:
    def __init__(self, camera_id):
        self.camera_id = camera_id
        self.stop_event = threading.Event()
        self.process = None
        self.state = {'running': False, 'started_at': None, 'last_segment_at': None, 'segments': 0,
                      'skipped': 0, 'error': None, 'restarts': 0}
        self.thread = threading.Thread(target=self._run, name=f'jagaai-live-{camera_id}', daemon=True)

    def _config(self):
        with session_scope() as session:
            camera = session.get(Camera, self.camera_id)
            if not camera or not camera.stream_enabled or not camera.stream_url:
                return None
            return camera.stream_url, camera.segment_sec, camera.name

    def _run(self):
        delay = 5
        while not self.stop_event.is_set():
            config = self._config()
            if not config:
                break
            url, seconds, name = config
            ffmpeg = ffmpeg_path()
            if not ffmpeg:
                self.state['error'] = 'FFmpeg was not found (tools/ or PATH); live recording cannot start.'
                publish_refresh('live', self.camera_id)
                self.stop_event.wait(60)
                continue
            folder = DATA_DIR / 'live' / self.camera_id / utcnow().strftime('%Y%m%d-%H%M%S')
            folder.mkdir(parents=True, exist_ok=True)
            try:
                command = segment_command(ffmpeg, url, folder, seconds)
            except RuntimeError as error:
                self.state['error'] = str(error)
                publish_refresh('live', self.camera_id)
                self.stop_event.wait(60)
                continue
            started = utcnow()
            self.simulated_source = url.startswith('demo:')
            stderr = (folder / 'ffmpeg.log').open('wb')
            try:
                self.process = subprocess.Popen(command, stdout=subprocess.DEVNULL, stderr=stderr,
                                                creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0))
            except OSError as error:
                stderr.close()
                self.state['error'] = f'FFmpeg could not start: {error}'[:300]
                self.stop_event.wait(delay)
                continue
            # Keep the last error until a segment actually arrives, so a retry is not shown as recording.
            self.state.update(running=True, started_at=started.isoformat())
            publish_refresh('live', self.camera_id)
            seen = 0
            while not self.stop_event.is_set():
                seen = self._collect(folder, started, seen, name)
                if self.process.poll() is not None:
                    seen = self._collect(folder, started, seen, name)
                    break
                self.stop_event.wait(1)
            if self.process.poll() is None:
                self.process.terminate()
                try:
                    self.process.wait(timeout=8)
                except subprocess.TimeoutExpired:
                    self.process.kill()
            stderr.close()
            self.state['running'] = False
            if self.stop_event.is_set():
                break
            # The camera dropped or refused the connection: report it and retry with backoff.
            detail = (folder / 'ffmpeg.log').read_text(encoding='utf-8', errors='replace').strip().splitlines()
            self.state['error'] = (explain(detail[-1]) if detail else f'Stream stopped (FFmpeg exit code {self.process.returncode}).')[:300]
            self.state['restarts'] += 1
            publish_refresh('live', self.camera_id)
            self.stop_event.wait(delay)
            delay = min(60, delay * 2) if seen == 0 else 5
        self.state['running'] = False
        publish_refresh('live', self.camera_id)

    def _collect(self, folder, started, seen, name):
        """Register segments FFmpeg has finished; the CSV lists a segment only once it is closed."""
        listing = folder / 'segments.csv'
        if not listing.is_file():
            return seen
        with listing.open(newline='', encoding='utf-8') as handle:
            rows = [row for row in csv.reader(handle) if len(row) >= 3]
        for filename, start, end in (row[:3] for row in rows[seen:]):
            try:
                self._register(folder / filename, started + timedelta(seconds=float(start)), float(end) - float(start), name)
            except Exception:
                log.exception('Could not register live segment %s', filename)
        return len(rows)

    def _register(self, path, recorded_at, duration, name):
        if not path.is_file() or duration <= 0.5:
            path.unlink(missing_ok=True)
            return
        from . import jobs
        with session_scope() as session:
            retention = session.get(AppSettings, 'global').retention_days
            backlog = len(session.exec(select(Video).where(Video.camera_id == self.camera_id, Video.source == 'live',
                                                          Video.status.in_(['queued', 'processing']))).all())
            local = recorded_at.astimezone(timezone(timedelta(hours=8)))
            video = Video(id=uid(), camera_id=self.camera_id, path=str(path), source='live', duration_sec=round(duration, 3),
                          is_simulation=getattr(self, 'simulated_source', False),
                          filename=f'{name} · live {local:%d %b %H:%M:%S}'[:255], recorded_at=recorded_at,
                          expires_at=utcnow() + timedelta(days=retention), status='queued')
            if backlog >= MAX_BACKLOG:
                # Keep the footage so it can be played or retried; do not let the queue grow without bound.
                video.status = 'failed'
                video.error = 'Not analysed: analysis is behind the live stream. The recording is kept; retry it from Cameras.'
                self.state['skipped'] += 1
            session.add(video)
            session.commit()
            queued = video.status == 'queued'
            ident = video.id
        self.state['segments'] += 1
        self.state['last_segment_at'] = utcnow().isoformat()
        self.state['error'] = None
        if queued:
            jobs.enqueue(ident)
        publish_refresh('video', ident)


def status(camera_id):
    recorder = _recorders.get(camera_id)
    return dict(recorder.state) if recorder and recorder.thread.is_alive() else None


def sync(camera_id):
    """Start, restart or stop one camera's recorder to match its saved settings."""
    with _lock:
        stop(camera_id, locked=True)
        with session_scope() as session:
            camera = session.get(Camera, camera_id)
            wanted = bool(camera and camera.stream_enabled and camera.stream_url)
        if wanted:
            recorder = Recorder(camera_id)
            _recorders[camera_id] = recorder
            recorder.thread.start()


def stop(camera_id, locked=False):
    def halt():
        recorder = _recorders.pop(camera_id, None)
        if recorder:
            recorder.stop_event.set()
            recorder.thread.join(timeout=15)
    if locked:
        halt()
    else:
        with _lock:
            halt()


def start_all():
    if os.environ.get('JAGAAI_LIVE', '1') != '1':
        return
    with session_scope() as session:
        cameras = [c.id for c in session.exec(select(Camera).where(Camera.stream_enabled == True)).all()]  # noqa: E712
    for camera_id in cameras:
        sync(camera_id)


def stop_all():
    for camera_id in list(_recorders):
        stop(camera_id)

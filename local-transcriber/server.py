from __future__ import annotations

import gc
import base64
import binascii
import ipaddress
import json
import os
import shutil
import site
import socket
import subprocess
import sys
import tempfile
import threading
import time
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any
from urllib.parse import urlsplit


def bounded_env_int(name: str, default: int, minimum: int, maximum: int) -> int:
    try:
        value = int(os.environ.get(name, str(default)))
    except (TypeError, ValueError):
        value = default
    return max(minimum, min(maximum, value))


HOST = "127.0.0.1"
PORT = int(os.environ.get("NOMO_TRANSCRIBER_PORT", "37819"))
MODEL_NAME = os.environ.get("NOMO_WHISPER_MODEL", "small").strip() or "small"
REQUESTED_DEVICE = os.environ.get("NOMO_DEVICE", "auto").strip().lower()
LANGUAGE = os.environ.get("NOMO_LANGUAGE", "zh").strip().lower()
MAX_VIDEO_SECONDS = int(os.environ.get("NOMO_MAX_VIDEO_SECONDS", "1800"))
GPU_COMPUTE_TYPE = os.environ.get("NOMO_GPU_COMPUTE_TYPE", "int8_float16").strip() or "int8_float16"
CPU_COMPUTE_TYPE = os.environ.get("NOMO_CPU_COMPUTE_TYPE", "int8").strip() or "int8"
CPU_THREADS = bounded_env_int("NOMO_CPU_THREADS", 2, 1, 8)
NUM_WORKERS = bounded_env_int("NOMO_NUM_WORKERS", 1, 1, 2)
BEAM_SIZE = bounded_env_int("NOMO_BEAM_SIZE", 1, 1, 5)
MAX_BODY_BYTES = 64 * 1024
MAX_INLINE_AUDIO_BYTES = 20 * 1024 * 1024
USER_AGENT = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
    "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131 Safari/537.36"
)

_dll_handles: list[Any] = []
_models: dict[str, Any] = {}
_model_lock = threading.Lock()
_transcribe_lock = threading.Lock()


class TranscriberError(RuntimeError):
    pass


def configure_nvidia_dlls() -> list[str]:
    """Expose CUDA DLLs installed by NVIDIA's Windows Python wheels."""
    if os.name != "nt":
        return []
    roots: list[Path] = []
    try:
        roots.extend(Path(p) for p in site.getsitepackages())
    except Exception:
        pass
    try:
        roots.append(Path(site.getusersitepackages()))
    except Exception:
        pass
    added: list[str] = []
    for root in roots:
        nvidia = root / "nvidia"
        if not nvidia.is_dir():
            continue
        for bin_dir in nvidia.glob("*/bin"):
            if not bin_dir.is_dir():
                continue
            path = str(bin_dir.resolve())
            if path in added:
                continue
            os.environ["PATH"] = path + os.pathsep + os.environ.get("PATH", "")
            try:
                _dll_handles.append(os.add_dll_directory(path))
            except (AttributeError, OSError):
                pass
            added.append(path)
    return added


CUDA_DLL_DIRS = configure_nvidia_dlls()


def has_nvidia_gpu() -> bool:
    command = shutil.which("nvidia-smi")
    if not command:
        return False
    try:
        result = subprocess.run(
            [command, "--query-gpu=name", "--format=csv,noheader"],
            capture_output=True,
            text=True,
            timeout=5,
            check=False,
        )
        return result.returncode == 0 and bool(result.stdout.strip())
    except Exception:
        return False


def preferred_device() -> str:
    if REQUESTED_DEVICE == "cpu":
        return "cpu"
    if REQUESTED_DEVICE == "cuda":
        return "cuda"
    return "cuda" if has_nvidia_gpu() and bool(CUDA_DLL_DIRS) else "cpu"


def lower_process_priority() -> None:
    """Keep transcription responsive-friendly; FFmpeg children inherit this on Windows."""
    if os.name != "nt":
        return
    try:
        import ctypes

        below_normal_priority_class = 0x00004000
        kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
        get_current_process = kernel32.GetCurrentProcess
        get_current_process.restype = ctypes.c_void_p
        set_priority_class = kernel32.SetPriorityClass
        set_priority_class.argtypes = [ctypes.c_void_p, ctypes.c_uint32]
        set_priority_class.restype = ctypes.c_int
        set_priority_class(get_current_process(), below_normal_priority_class)
    except Exception:
        pass


def get_model(device: str):
    with _model_lock:
        if device in _models:
            return _models[device]
        from faster_whisper import WhisperModel

        compute_type = GPU_COMPUTE_TYPE if device == "cuda" else CPU_COMPUTE_TYPE
        print(f"[Nomo] 正在加载 {MODEL_NAME} 模型（{device}/{compute_type}）...", flush=True)
        try:
            model = WhisperModel(
                MODEL_NAME,
                device=device,
                compute_type=compute_type,
                cpu_threads=CPU_THREADS,
                num_workers=NUM_WORKERS,
            )
        except Exception as error:
            if device != "cuda" or compute_type == "float16":
                raise
            print(f"[Nomo] 低显存模式不可用，改用 CUDA float16：{error}", flush=True)
            model = WhisperModel(
                MODEL_NAME,
                device=device,
                compute_type="float16",
                cpu_threads=CPU_THREADS,
                num_workers=NUM_WORKERS,
            )
        _models[device] = model
        return model


def release_model(device: str) -> None:
    with _model_lock:
        model = _models.pop(device, None)
        if model is not None:
            del model
    gc.collect()


def is_douyin_page(url: str) -> bool:
    try:
        parsed = urlsplit(url)
        host = (parsed.hostname or "").lower().rstrip(".")
        return parsed.scheme == "https" and (host == "douyin.com" or host.endswith(".douyin.com"))
    except Exception:
        return False


DOUYIN_MEDIA_HOST_SUFFIXES = (
    "douyin.com",
    "iesdouyin.com",
    "douyinvod.com",
    "zjcdn.com",
    "bytevcloud.com",
)


def is_trusted_douyin_media_host(host: str) -> bool:
    normalized = host.lower().rstrip(".")
    return any(
        normalized == suffix or normalized.endswith(f".{suffix}")
        for suffix in DOUYIN_MEDIA_HOST_SUFFIXES
    )


def is_public_https(url: str) -> bool:
    try:
        parsed = urlsplit(url)
        if parsed.scheme != "https" or not parsed.hostname or parsed.username or parsed.password:
            return False
        host = parsed.hostname.lower().rstrip(".")
        if host in {"localhost", "localhost.localdomain"} or host.endswith(".local"):
            return False
        # Clash/代理软件的 Fake-IP 模式会把正常抖音 CDN 解析到 198.18.0.0/15。
        # 仅对白名单内、仍为 HTTPS 且无账号信息的抖音/字节 CDN 跳过 DNS 公网检查；
        # 任意第三方域名和字面量 IP 继续走严格 SSRF 校验。
        if is_trusted_douyin_media_host(host):
            return True
        try:
            addresses = [ipaddress.ip_address(host)]
        except ValueError:
            addresses = [
                ipaddress.ip_address(item[4][0])
                for item in socket.getaddrinfo(host, 443, type=socket.SOCK_STREAM)
            ]
        return bool(addresses) and all(
            not (
                address.is_private
                or address.is_loopback
                or address.is_link_local
                or address.is_multicast
                or address.is_reserved
            )
            for address in addresses
        )
    except Exception:
        return False


def run_ffmpeg_audio(command: list[str], output: Path) -> None:
    result = subprocess.run(command, capture_output=True, text=True, timeout=20 * 60, check=False)
    if result.returncode != 0 or not output.exists() or output.stat().st_size < 1024:
        detail = (result.stderr or "").strip().splitlines()
        suffix = " | ".join(detail[-6:])[-900:] if detail else "视频音频为空"
        raise TranscriberError(f"无法读取抖音视频音频：{suffix}")


def extract_audio_file(input_file: Path, output: Path) -> None:
    ffmpeg = shutil.which("ffmpeg")
    if not ffmpeg:
        raise TranscriberError("未找到 FFmpeg，请先安装 FFmpeg 并加入 PATH")
    command = [
        ffmpeg,
        "-nostdin",
        "-hide_banner",
        "-loglevel",
        "error",
        "-i",
        str(input_file),
        "-t",
        str(MAX_VIDEO_SECONDS),
        "-vn",
        "-ac",
        "1",
        "-ar",
        "16000",
        "-c:a",
        "pcm_s16le",
        "-y",
        str(output),
    ]
    run_ffmpeg_audio(command, output)


def extract_audio(media_url: str, page_url: str, output: Path) -> None:
    ffmpeg = shutil.which("ffmpeg")
    if not ffmpeg:
        raise TranscriberError("未找到 FFmpeg，请先安装 FFmpeg 并加入 PATH")
    headers = f"Referer: {page_url}\r\nUser-Agent: {USER_AGENT}\r\n"
    command = [
        ffmpeg,
        "-nostdin",
        "-hide_banner",
        "-loglevel",
        "error",
        "-rw_timeout",
        "30000000",
        "-headers",
        headers,
        "-i",
        media_url,
        "-t",
        str(MAX_VIDEO_SECONDS),
        "-vn",
        "-ac",
        "1",
        "-ar",
        "16000",
        "-c:a",
        "pcm_s16le",
        "-y",
        str(output),
    ]
    run_ffmpeg_audio(command, output)


def inline_audio_suffix(raw_audio: bytes, mime: str) -> str:
    normalized = mime.lower().split(";", 1)[0].strip()
    if raw_audio[:4] == b"RIFF" and raw_audio[8:12] == b"WAVE":
        return ".wav"
    if len(raw_audio) >= 12 and raw_audio[4:8] == b"ftyp":
        return ".m4a"
    if raw_audio[:3] == b"ID3" or (
        len(raw_audio) >= 2 and raw_audio[0] == 0xFF and (raw_audio[1] & 0xE0) == 0xE0
    ):
        return ".mp3" if "mpeg" in normalized else ".aac"
    raise TranscriberError(f"浏览器音轨格式不受支持（{normalized or '未知类型'}）")


def run_whisper(audio: Path, device: str) -> tuple[list[dict[str, Any]], float, str]:
    model = get_model(device)
    language = None if LANGUAGE in {"", "auto"} else LANGUAGE
    segments_iter, info = model.transcribe(
        str(audio),
        language=language,
        beam_size=BEAM_SIZE,
        best_of=1,
        temperature=0.0,
        vad_filter=True,
        vad_parameters={"min_silence_duration_ms": 500},
        condition_on_previous_text=True,
    )
    segments: list[dict[str, Any]] = []
    for segment in segments_iter:
        text = (segment.text or "").strip()
        if text:
            segments.append(
                {
                    "start": round(max(0.0, float(segment.start)), 2),
                    "end": round(max(0.0, float(segment.end)), 2),
                    "text": text,
                }
            )
    return segments, float(getattr(info, "duration", 0.0) or 0.0), device


def transcribe(payload: dict[str, Any]) -> dict[str, Any]:
    lower_process_priority()
    media_url = str(payload.get("mediaUrl", "")).strip()
    audio_base64 = str(payload.get("audioBase64", "")).strip()
    audio_mime = str(payload.get("audioMime", "audio/mp4")).strip().lower()
    page_url = str(payload.get("pageUrl", "")).strip()
    if not is_douyin_page(page_url):
        raise TranscriberError("只接受来自 douyin.com 的页面")
    if not audio_base64 and not is_public_https(media_url):
        rejected_host = (urlsplit(media_url).hostname or "未知主机").lower().rstrip(".")
        raise TranscriberError(f"抖音视频地址校验失败（{rejected_host}）：不是允许的公开 HTTPS 媒体")
    started = time.perf_counter()
    with tempfile.TemporaryDirectory(prefix="nomo-transcribe-") as temp:
        audio = Path(temp) / "audio.wav"
        if audio_base64:
            if len(audio_base64) > ((MAX_INLINE_AUDIO_BYTES + 2) // 3) * 4:
                raise TranscriberError("页面音频过大，请选择 30 分钟以内的视频")
            try:
                raw_audio = base64.b64decode(audio_base64, validate=True)
            except (binascii.Error, ValueError):
                raise TranscriberError("页面音频数据无效")
            if len(raw_audio) < 1024 or len(raw_audio) > MAX_INLINE_AUDIO_BYTES:
                raise TranscriberError("页面音频大小无效")
            suffix = inline_audio_suffix(raw_audio, audio_mime)
            if suffix == ".wav":
                if len(raw_audio) < 44:
                    raise TranscriberError("页面音频 WAV 头不完整")
                channels = int.from_bytes(raw_audio[22:24], "little")
                sample_rate = int.from_bytes(raw_audio[24:28], "little")
                audio_format = int.from_bytes(raw_audio[20:22], "little")
                bits_per_sample = int.from_bytes(raw_audio[34:36], "little")
                declared_riff_size = int.from_bytes(raw_audio[4:8], "little") + 8
                declared_data_size = int.from_bytes(raw_audio[40:44], "little")
                if (
                    raw_audio[12:16] != b"fmt "
                    or raw_audio[36:40] != b"data"
                    or declared_riff_size != len(raw_audio)
                    or declared_data_size != len(raw_audio) - 44
                ):
                    raise TranscriberError("页面音频 WAV 结构无效")
                if audio_format != 1 or channels != 1 or sample_rate != 16_000 or bits_per_sample != 16:
                    raise TranscriberError("页面 WAV 必须为 16kHz 单声道 16-bit PCM")
                duration = (len(raw_audio) - 44) / (sample_rate * channels * (bits_per_sample // 8))
                if duration <= 0 or duration > min(MAX_VIDEO_SECONDS, 10 * 60) + 1:
                    raise TranscriberError("页面 WAV 时长无效或超过 10 分钟")
                audio.write_bytes(raw_audio)
            else:
                compressed = Path(temp) / f"browser-audio{suffix}"
                compressed.write_bytes(raw_audio)
                extract_audio_file(compressed, audio)
            print("[Nomo] 已接收并解码浏览器下载的当前视频音轨...", flush=True)
        else:
            print("[Nomo] 正在读取当前抖音视频音频...", flush=True)
            extract_audio(media_url, page_url, audio)
        device = preferred_device()
        try:
            segments, duration, used_device = run_whisper(audio, device)
        except Exception as error:
            if device != "cuda" or REQUESTED_DEVICE == "cuda":
                raise
            print(f"[Nomo] 显卡模式失败，自动改用 CPU：{error}", flush=True)
            release_model("cuda")
            segments, duration, used_device = run_whisper(audio, "cpu")
    elapsed = time.perf_counter() - started
    return {
        "ok": True,
        "model": MODEL_NAME,
        "device": used_device,
        "profile": "low-load",
        "duration": round(duration, 2),
        "elapsed": round(elapsed, 2),
        "segments": segments,
    }


class Handler(BaseHTTPRequestHandler):
    server_version = "NomoLocalTranscriber/2.0.3"

    def log_message(self, fmt: str, *args: Any) -> None:
        print(f"[Nomo] {self.address_string()} {fmt % args}", flush=True)

    def allowed_origin(self) -> str | None:
        origin = self.headers.get("Origin", "")
        if not origin:
            return "*"
        return origin if origin.startswith("chrome-extension://") else None

    def send_json(self, status: int, data: dict[str, Any]) -> None:
        body = json.dumps(data, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        origin = self.allowed_origin()
        if origin:
            self.send_header("Access-Control-Allow-Origin", origin)
            self.send_header("Vary", "Origin")
        self.send_header("Access-Control-Allow-Private-Network", "true")
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def origin_ok(self) -> bool:
        if self.allowed_origin() is not None:
            return True
        self.send_json(HTTPStatus.FORBIDDEN, {"ok": False, "error": "拒绝非扩展页面调用"})
        return False

    def do_OPTIONS(self) -> None:
        if not self.origin_ok():
            return
        self.send_response(HTTPStatus.NO_CONTENT)
        origin = self.allowed_origin()
        if origin:
            self.send_header("Access-Control-Allow-Origin", origin)
            self.send_header("Vary", "Origin")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.send_header("Access-Control-Allow-Private-Network", "true")
        self.end_headers()

    def do_GET(self) -> None:
        if not self.origin_ok():
            return
        if self.path != "/health":
            self.send_json(HTTPStatus.NOT_FOUND, {"ok": False, "error": "接口不存在"})
            return
        self.send_json(
            HTTPStatus.OK,
            {
                "ok": True,
                "service": "nomo-local-transcriber",
                "version": "2.0.3",
                "model": MODEL_NAME,
                "requestedDevice": REQUESTED_DEVICE,
                "preferredDevice": preferred_device(),
            },
        )

    def do_POST(self) -> None:
        if not self.origin_ok():
            return
        if self.path != "/transcribe":
            self.send_json(HTTPStatus.NOT_FOUND, {"ok": False, "error": "接口不存在"})
            return
        length = int(self.headers.get("Content-Length", "0") or "0")
        if length <= 0 or length > MAX_BODY_BYTES:
            self.send_json(HTTPStatus.BAD_REQUEST, {"ok": False, "error": "请求内容大小无效"})
            return
        try:
            payload = json.loads(self.rfile.read(length).decode("utf-8"))
        except Exception:
            self.send_json(HTTPStatus.BAD_REQUEST, {"ok": False, "error": "请求 JSON 无效"})
            return
        if not isinstance(payload, dict):
            self.send_json(HTTPStatus.BAD_REQUEST, {"ok": False, "error": "请求格式无效"})
            return
        if not _transcribe_lock.acquire(blocking=False):
            self.send_json(HTTPStatus.CONFLICT, {"ok": False, "error": "已有字幕任务正在运行"})
            return
        try:
            result = transcribe(payload)
            self.send_json(HTTPStatus.OK, result)
        except subprocess.TimeoutExpired:
            self.send_json(HTTPStatus.REQUEST_TIMEOUT, {"ok": False, "error": "处理超时，请重试"})
        except TranscriberError as error:
            self.send_json(HTTPStatus.BAD_REQUEST, {"ok": False, "error": str(error)})
        except Exception as error:
            print(f"[Nomo] 转录失败：{type(error).__name__}: {error}", flush=True)
            self.send_json(
                HTTPStatus.INTERNAL_SERVER_ERROR,
                {"ok": False, "error": f"本地转录失败：{type(error).__name__}: {error}"},
            )
        finally:
            _transcribe_lock.release()


def main() -> None:
    lower_process_priority()
    if REQUESTED_DEVICE not in {"auto", "cuda", "cpu"}:
        raise SystemExit("NOMO_DEVICE 只能是 auto、cuda 或 cpu")
    print("Nomo 本地抖音字幕服务", flush=True)
    print(f"地址：http://{HOST}:{PORT}", flush=True)
    print(
        f"模型：{MODEL_NAME}，模式：{REQUESTED_DEVICE}，低占用：{CPU_THREADS} 线程 / beam {BEAM_SIZE}，"
        f"最长视频：{MAX_VIDEO_SECONDS // 60} 分钟",
        flush=True,
    )
    print("请保持此窗口开启；按 Ctrl+C 可停止服务。", flush=True)
    server = ThreadingHTTPServer((HOST, PORT), Handler)
    try:
        server.serve_forever(poll_interval=0.25)
    except KeyboardInterrupt:
        print("\n[Nomo] 服务已停止。", flush=True)
    finally:
        server.server_close()


if __name__ == "__main__":
    main()

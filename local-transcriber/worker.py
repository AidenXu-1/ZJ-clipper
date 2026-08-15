from __future__ import annotations

import contextlib
import json
import sys
import traceback

import server


def emit(value: object) -> None:
    body = json.dumps(value, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    sys.stdout.buffer.write(body)
    sys.stdout.buffer.flush()


def main() -> None:
    try:
        payload = json.loads(sys.stdin.buffer.read().decode("utf-8"))
        if not isinstance(payload, dict) or payload.get("type") != "transcribe":
            raise ValueError("请求格式无效")
        # server.transcribe 的进度只进入 host 日志，stdout 必须只保留最终 JSON。
        with contextlib.redirect_stdout(sys.stderr):
            result = server.transcribe(payload)
        emit(result)
    except Exception as exc:
        traceback.print_exc(file=sys.stderr)
        emit({"ok": False, "error": f"本地转录失败：{type(exc).__name__}: {exc}"})


if __name__ == "__main__":
    main()

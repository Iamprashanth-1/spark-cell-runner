import base64
import contextlib
import io
import json
import sys
import traceback
globals_ns = {"__name__": "__main__"}
try:
    sys.stdin.reconfigure(line_buffering=True)
except Exception:
    pass
print(json.dumps({"type": "ready"}), flush=True)
while True:
    raw = sys.stdin.readline()
    if raw == "":
        break
    raw = raw.strip()
    if not raw:
        continue
    message = json.loads(raw)
    if message.get("type") != "exec":
        continue
    code = base64.b64decode(message["code"]).decode("utf-8")
    stdout_buffer = io.StringIO()
    stderr_buffer = io.StringIO()
    ok = True
    try:
        with contextlib.redirect_stdout(stdout_buffer), contextlib.redirect_stderr(stderr_buffer):
            exec(code, globals_ns, globals_ns)
    except BaseException:
        ok = False
        traceback.print_exc(file=stderr_buffer)
    print(json.dumps({
        "type": "result",
        "id": message["id"],
        "ok": ok,
        "stdout": stdout_buffer.getvalue(),
        "stderr": stderr_buffer.getvalue(),
    }), flush=True)

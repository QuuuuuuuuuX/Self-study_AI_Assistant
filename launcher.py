"""启动Self-Learning Space：确保本地服务在跑（没有就拉起），然后开原生窗口；失败则退回浏览器。"""
import os
import shutil
import socket
import subprocess
import sys
import time
import urllib.request
import webbrowser

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
os.chdir(BASE_DIR)

HOST, PORT = "127.0.0.1", 8765
URL = f"http://{HOST}:{PORT}"
LOG_PATH = os.path.join(BASE_DIR, "data", "server.log")


# 健康检查绕过环境代理：launcher 若从带 HTTP_PROXY 的环境启动，
# 代理配置异常时可能干扰本机请求；显式空代理最稳。
_NO_PROXY = urllib.request.build_opener(urllib.request.ProxyHandler({}))

# 端口被占时给用户的操作提示：命令必须分平台，Windows 没有 lsof / xargs
_PORT_HINT = (
    "请在命令提示符执行 netstat -ano | findstr :8765 找到 PID，再 taskkill /PID <pid> /F"
    if os.name == "nt" else
    "请执行 lsof -ti:8765 | xargs kill"
)


def server_ready() -> bool:
    try:
        with _NO_PROXY.open(f"{URL}/api/health", timeout=3) as r:
            return r.status == 200
    except Exception:
        return False


def port_in_use() -> bool:
    """8765 是否已有进程在监听 —— 说明服务实例已存在（可能只是暂时忙）。"""
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.settimeout(0.4)
        return s.connect_ex((HOST, PORT)) == 0


def ensure_server():
    if server_ready():
        return
    # 关键：端口已被占用说明**已有服务实例**，可能只是暂时忙（正在跑 AI 任务时
    # 健康检查会超时）。此时绝不能再起第二个，否则必然 address already in use，
    # 然后进程退出、App 打不开（实测踩过）。
    if port_in_use():
        for _ in range(30):          # 再等它 15 秒
            if server_ready():
                return
            time.sleep(0.5)
        raise RuntimeError(
            "8765 端口有服务在监听，但它没响应健康检查。"
            + _PORT_HINT + " 后重新打开。"
        )
    log = open(LOG_PATH, "ab")
    # 清掉继承来的代理变量：沙箱 / 开发环境的代理端口是动态的，服务进程一旦固化了
    # HTTP_PROXY 变量，端口一换就指向死端口，每次调外部 API 都 Connection refused（实测踩过）
    env = {k: v for k, v in os.environ.items()
           if k.lower() not in ("http_proxy", "https_proxy", "all_proxy", "no_proxy")}
    subprocess.Popen(
        [sys.executable, "-m", "uvicorn", "backend.app:app",
         "--host", HOST, "--port", str(PORT), "--log-level", "warning"],
        cwd=BASE_DIR, stdout=log, stderr=log, env=env,
    )
    for _ in range(40):  # 最多等 20 秒
        if server_ready():
            return
        time.sleep(0.5)
    raise RuntimeError(
        "本地服务启动失败。请查看 data/server.log；"
        "若日志里出现 “address already in use”，说明 8765 端口被别的进程占着，"
        + _PORT_HINT + " 后重试。"
    )


class JsApi:
    """前端 -> 原生：导出文件用系统保存对话框（Web 内下载在 WKWebView 不可靠）。"""

    def export_materials(self, ids_json: str) -> str:
        import json as _json
        import tempfile
        import zipfile as _zipfile
        import webview as _wv
        from backend import store
        from backend.config import material_file_path
        ids = _json.loads(ids_json or "[]")
        mats = []
        for mid in ids[:200]:
            m = store.get_material(mid)
            if m and not m["deleted"]:
                mats.append(m)
        if not mats:
            return ""
        tmp = tempfile.NamedTemporaryFile(suffix=".zip", delete=False)
        used = set()
        with _zipfile.ZipFile(tmp, "w", _zipfile.ZIP_DEFLATED) as z:
            for m in mats:
                ext = (m.get("ext") or "pdf").lower()
                fp = material_file_path(m["id"], ext)
                if not os.path.exists(fp):
                    continue
                arc = store.fix_zip_name(m["orig_name"])   # 库里若存了乱码名，导出时还原
                if arc in used:
                    arc = f"{len(used)+1}_{arc}"
                used.add(arc)
                z.write(fp, arc)
        tmp.close()
        window = _wv.windows[0]
        target = window.create_file_dialog(
            _wv.SAVE_DIALOG, save_filename="materials_export.zip",
            file_types=("Zip 压缩包 (*.zip)",))
        if not target:
            return ""
        target = target[0] if isinstance(target, (list, tuple)) else target
        shutil.copy(tmp.name, target)
        return target

    def export_one(self, mid: str) -> str:
        import shutil as _shutil2
        import webview as _wv
        from backend import store
        from backend.config import material_file_path
        m = store.get_material(mid)
        if not m or m["deleted"]:
            return ""
        ext = (m.get("ext") or "pdf").lower()
        fp = material_file_path(m["id"], ext)
        if not os.path.exists(fp):
            return ""
        window = _wv.windows[0]
        target = window.create_file_dialog(
            _wv.SAVE_DIALOG, save_filename=m["orig_name"],
            file_types=("All files (*.*)",))
        if not target:
            return ""
        target = target[0] if isinstance(target, (list, tuple)) else target
        _shutil2.copy(fp, target)
        return target


def main():
    ensure_server()
    try:
        import webview
        webview.create_window("Self-Learning Space", URL, width=1240, height=820,
                              js_api=JsApi())
        webview.start()
    except Exception:
        # pywebview 不可用（或窗口异常），退回浏览器模式
        webbrowser.open(URL)
        # 保持进程存活，避免用户关闭终端脚本时误杀服务（服务本身是独立进程，不受影响）
        try:
            while True:
                time.sleep(3600)
        except KeyboardInterrupt:
            pass


if __name__ == "__main__":
    main()

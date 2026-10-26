"""全局配置：data/ 目录、config.json（API Key 等设置）。"""
import json
import os

BASE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA_DIR = os.path.join(BASE_DIR, "data")
FILES_DIR = os.path.join(DATA_DIR, "files")
CONFIG_PATH = os.path.join(DATA_DIR, "config.json")

os.makedirs(FILES_DIR, exist_ok=True)

DEFAULT_CONFIG = {
    "api_key": "",
    "model": "deepseek-chat",
    "base_url": "https://api.deepseek.com",
    "threshold": 0.42,  # 相似度低于此值视为“资料库中没有相关内容”
    "top_k": 5,
}

_config_cache: dict | None = None
_config_stamp: float = -1.0        # 上次缓存时的文件 mtime，用来判断要不要重读


def load_config() -> dict:
    """读配置。按文件 mtime 缓存：每次问答/注释都要调它，不必每次读盘解析 JSON。"""
    global _config_cache, _config_stamp
    try:
        stamp = os.path.getmtime(CONFIG_PATH) if os.path.exists(CONFIG_PATH) else 0.0
    except OSError:
        stamp = 0.0
    if _config_cache is not None and stamp == _config_stamp:
        return _config_cache

    cfg = dict(DEFAULT_CONFIG)
    if stamp:
        try:
            with open(CONFIG_PATH, "r", encoding="utf-8") as f:
                cfg.update(json.load(f))
        except Exception as e:  # noqa: BLE001
            # 配置坏了要能看见原因，不能静默当默认值（否则表现为"Key 突然失效"）
            print(f"[config] 读取 {CONFIG_PATH} 失败，本次使用默认配置：{e}")
    # 环境变量兜底
    env_key = os.environ.get("DEEPSEEK_API_KEY")
    if env_key and not cfg.get("api_key"):
        cfg["api_key"] = env_key
    _config_cache, _config_stamp = cfg, stamp
    return cfg


def save_config(patch: dict):
    global _config_stamp
    cfg = dict(load_config())
    cfg.update(patch)
    with open(CONFIG_PATH, "w", encoding="utf-8") as f:
        json.dump(cfg, f, ensure_ascii=False, indent=2)
    _config_cache = cfg
    _config_stamp = -1.0          # 下次读取强制重新解析（以磁盘为准）
    return cfg


def material_file_path(material_id: str, ext: str = "pdf") -> str:
    return os.path.join(FILES_DIR, f"{material_id}.{ext}")


def handbook_path(course_id: str, ext: str = "pdf") -> str:
    return os.path.join(FILES_DIR, f"handbook_{course_id}.{ext}")

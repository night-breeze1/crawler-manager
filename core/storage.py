import json
import shutil
from pathlib import Path
from typing import List, Optional, Iterator, Tuple

from config import IGNORE_DIRS, IGNORE_FILES, MAX_SOURCE_FILE_SIZE, MAX_SOURCE_PREVIEW_LINES


def safe_name(name: str) -> str:
    keep = "-_."
    cleaned = "".join(c if (c.isalnum() or c in keep) else "_" for c in name).strip("._-")
    return cleaned or "unnamed"


def is_ignored_dir(dir_name: str) -> bool:
    if dir_name in IGNORE_DIRS:
        return True
    if dir_name.endswith(".egg-info"):
        return True
    return False


def is_ignored_file(file_name: str) -> bool:
    if file_name in IGNORE_FILES:
        return True
    if file_name.endswith(".pyc") or file_name.endswith(".pyo"):
        return True
    return False


def iter_source_files(root: Path) -> Iterator[Path]:
    for path in root.rglob("*"):
        if not path.is_file():
            continue
        if any(is_ignored_dir(part) for part in path.relative_to(root).parts[:-1]):
            continue
        if is_ignored_file(path.name):
            continue
        yield path


def copy_tree_filtered(src: Path, dst: Path) -> Tuple[int, int]:
    file_count = 0
    total_size = 0
    for f in iter_source_files(src):
        rel = f.relative_to(src)
        target = dst / rel
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(f, target)
        file_count += 1
        total_size += f.stat().st_size
    return file_count, total_size


def read_json(path: Path) -> Optional[dict]:
    if not path.exists():
        return None
    with path.open("r", encoding="utf-8") as fp:
        return json.load(fp)


def write_json(path: Path, data: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8") as fp:
        json.dump(data, fp, ensure_ascii=False, indent=2)


def read_text_file(path: Path) -> Optional[str]:
    if not path.exists() or not path.is_file():
        return None
    if path.stat().st_size > MAX_SOURCE_FILE_SIZE:
        return f"[[文件过大，超过 {MAX_SOURCE_FILE_SIZE // 1024 // 1024}MB，未读取]]"
    try:
        with path.open("r", encoding="utf-8") as fp:
            lines = fp.readlines(MAX_SOURCE_PREVIEW_LINES + 1)
        if len(lines) > MAX_SOURCE_PREVIEW_LINES:
            return "".join(lines[:MAX_SOURCE_PREVIEW_LINES]) + f"\n\n[[已截断，仅显示前 {MAX_SOURCE_PREVIEW_LINES} 行]]"
        return "".join(lines)
    except UnicodeDecodeError:
        return "[[二进制文件，无法以文本形式展示]]"


def is_text_file(path: Path) -> bool:
    text_exts = {
        ".py", ".js", ".ts", ".html", ".css", ".scss", ".less",
        ".json", ".yaml", ".yml", ".xml", ".toml", ".ini", ".cfg",
        ".md", ".txt", ".rst", ".log", ".sh", ".bat", ".ps1",
        ".sql", ".gitignore", ".env", ".conf", ".properties",
        ".java", ".c", ".cpp", ".h", ".hpp", ".cs", ".go", ".rs",
        ".rb", ".php", ".swift", ".kt", ".scala", ".lua", ".r",
        ".vue", ".jsx", ".tsx", ".svg",
    }
    if path.suffix.lower() in text_exts:
        return True
    if path.suffix == "":
        try:
            with path.open("r", encoding="utf-8") as fp:
                fp.read(2048)
            return True
        except UnicodeDecodeError:
            return False
    return False


def dir_size(root: Path) -> int:
    total = 0
    for p in root.rglob("*"):
        if p.is_file():
            try:
                total += p.stat().st_size
            except OSError:
                pass
    return total


def format_size(size: int) -> str:
    units = ["B", "KB", "MB", "GB", "TB"]
    idx = 0
    s = float(size)
    while s >= 1024 and idx < len(units) - 1:
        s /= 1024
        idx += 1
    return f"{s:.2f} {units[idx]}"
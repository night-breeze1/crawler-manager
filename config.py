import os
from pathlib import Path

BASE_DIR = Path(__file__).resolve().parent
DATA_DIR = BASE_DIR / "data"
PROJECTS_DIR = DATA_DIR / "projects"

MAX_CONTENT_LENGTH = 500 * 1024 * 1024

DEFAULT_FLOW_NOTES = """# {project_name} 思路流程

> 用于记录该爬虫项目的核心思路、关键步骤与踩坑经验，方便后续版本迭代时参考。

## 一、目标描述


## 二、整体思路


## 三、关键步骤


## 四、核心代码点


## 五、踩坑记录


## 六、后续可优化

"""

IGNORE_DIRS = {
    "__pycache__", ".pytest_cache", ".mypy_cache", ".ruff_cache",
    ".git", ".svn", ".hg", ".idea", ".vscode",
    "node_modules", ".venv", "venv", "env", ".env",
    "dist", "build", ".eggs", "*.egg-info",
}

IGNORE_FILES = {
    ".DS_Store", "Thumbs.db", ".gitignore",
}

MAX_SOURCE_FILE_SIZE = 2 * 1024 * 1024
MAX_SOURCE_PREVIEW_LINES = 2000

os.makedirs(PROJECTS_DIR, exist_ok=True)
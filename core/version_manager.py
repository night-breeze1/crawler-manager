from dataclasses import dataclass
from pathlib import Path
from typing import List, Optional, Dict, Any

from core import storage


@dataclass
class FileNode:
    name: str
    path: str
    is_dir: bool
    size: int = 0
    children: List["FileNode"] = None

    def to_dict(self) -> Dict[str, Any]:
        return {
            "name": self.name,
            "path": self.path,
            "is_dir": self.is_dir,
            "size": self.size,
            "children": [c.to_dict() for c in (self.children or [])],
        }


def build_file_tree(root: Path, base: Path = None) -> FileNode:
    base = base or root
    node = FileNode(
        name=root.name,
        path=str(root.relative_to(base)).replace("\\", "/"),
        is_dir=root.is_dir(),
        size=root.stat().st_size if root.is_file() else 0,
    )
    if root.is_dir():
        children = []
        for child in sorted(root.iterdir(), key=lambda p: (not p.is_dir(), p.name.lower())):
            if child.is_dir():
                if storage.is_ignored_dir(child.name):
                    continue
                if not any(child.iterdir()):
                    continue
                children.append(build_file_tree(child, base))
            else:
                if storage.is_ignored_file(child.name):
                    continue
                children.append(FileNode(
                    name=child.name,
                    path=str(child.relative_to(base)).replace("\\", "/"),
                    is_dir=False,
                    size=child.stat().st_size,
                ))
        node.children = children
    return node


def read_source_file(root: Path, rel_path: str) -> Optional[dict]:
    target = (root / rel_path).resolve()
    root_resolved = root.resolve()
    try:
        target.relative_to(root_resolved)
    except ValueError:
        return None
    if not target.exists() or not target.is_file():
        return None
    content = storage.read_text_file(target)
    return {
        "path": rel_path.replace("\\", "/"),
        "name": target.name,
        "size": target.stat().st_size,
        "is_text": storage.is_text_file(target),
        "content": content,
    }


def flatten_tree(node: FileNode) -> List[Dict[str, Any]]:
    result = []
    for child in (node.children or []):
        result.append({
            "name": child.name,
            "path": child.path,
            "is_dir": child.is_dir,
            "size": child.size,
        })
        if child.is_dir:
            result.extend(flatten_tree(child))
    return result
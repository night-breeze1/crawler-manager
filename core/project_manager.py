from pathlib import Path
from typing import List, Optional, Dict, Any

from config import PROJECTS_DIR, DEFAULT_FLOW_NOTES
from core.models import ProjectMeta, VersionInfo, now_str
from core import storage


class ProjectManager:
    def __init__(self, root: Path = PROJECTS_DIR):
        self.root = root
        self.root.mkdir(parents=True, exist_ok=True)

    def _project_dir(self, name: str) -> Path:
        return self.root / storage.safe_name(name)

    def _meta_path(self, name: str) -> Path:
        return self._project_dir(name) / "metadata.json"

    def _flow_path(self, name: str) -> Path:
        return self._project_dir(name) / "flow_notes.md"

    def _versions_dir(self, name: str) -> Path:
        return self._project_dir(name) / "versions"

    def list_projects(self) -> List[ProjectMeta]:
        result = []
        for child in sorted(self.root.iterdir()):
            if not child.is_dir():
                continue
            meta = storage.read_json(child / "metadata.json")
            if meta:
                result.append(ProjectMeta.from_dict(meta))
        return result

    def get_project(self, name: str) -> Optional[ProjectMeta]:
        data = storage.read_json(self._meta_path(name))
        return ProjectMeta.from_dict(data) if data else None

    def exists(self, name: str) -> bool:
        return self._meta_path(name).exists()

    def create_project(
        self,
        name: str,
        description: str,
        tags: Optional[List[str]] = None,
        source_dir: Optional[Path] = None,
        initial_version: str = "v1.0.0",
        version_description: str = "",
    ) -> ProjectMeta:
        safe = storage.safe_name(name)
        if self.exists(safe):
            raise ValueError(f"项目已存在: {safe}")

        project_dir = self._project_dir(safe)
        project_dir.mkdir(parents=True, exist_ok=True)

        meta = ProjectMeta(
            name=safe,
            description=description,
            created_at=now_str(),
            updated_at=now_str(),
            current_version=None,
            versions=[],
            tags=tags or [],
        )

        flow = self._flow_path(safe)
        flow.write_text(DEFAULT_FLOW_NOTES.format(project_name=safe), encoding="utf-8")

        if source_dir is not None and Path(source_dir).exists():
            self._add_version_internal(meta, source_dir, initial_version, version_description)

        storage.write_json(self._meta_path(safe), meta.to_dict())
        return meta

    def update_project_meta(
        self,
        name: str,
        description: Optional[str] = None,
        tags: Optional[List[str]] = None,
    ) -> ProjectMeta:
        meta = self.get_project(name)
        if not meta:
            raise ValueError(f"项目不存在: {name}")
        if description is not None:
            meta.description = description
        if tags is not None:
            meta.tags = tags
        meta.updated_at = now_str()
        storage.write_json(self._meta_path(name), meta.to_dict())
        return meta

    def delete_project(self, name: str) -> bool:
        project_dir = self._project_dir(name)
        if not project_dir.exists():
            return False
        import shutil
        shutil.rmtree(project_dir, ignore_errors=True)
        return True

    def add_version(
        self,
        name: str,
        source_dir: Path,
        version: str,
        description: str = "",
    ) -> ProjectMeta:
        meta = self.get_project(name)
        if not meta:
            raise ValueError(f"项目不存在: {name}")
        if any(v.version == version for v in meta.versions):
            raise ValueError(f"版本已存在: {version}")
        self._add_version_internal(meta, Path(source_dir), version, description)
        storage.write_json(self._meta_path(name), meta.to_dict())
        return meta

    def _add_version_internal(
        self,
        meta: ProjectMeta,
        source_dir: Path,
        version: str,
        description: str,
    ) -> None:
        version_dir = self._versions_dir(meta.name) / version
        source_target = version_dir / "source"
        if source_target.exists():
            import shutil
            shutil.rmtree(source_target, ignore_errors=True)
        source_target.mkdir(parents=True, exist_ok=True)

        file_count, total_size = storage.copy_tree_filtered(source_dir, source_target)

        version_info = VersionInfo(
            version=version,
            created_at=now_str(),
            description=description,
            file_count=file_count,
            total_size=total_size,
        )
        meta.versions.append(version_info)
        meta.versions.sort(key=lambda v: v.version)
        if meta.current_version is None:
            meta.current_version = version
        meta.updated_at = now_str()

    def switch_version(self, name: str, version: str) -> ProjectMeta:
        meta = self.get_project(name)
        if not meta:
            raise ValueError(f"项目不存在: {name}")
        if not any(v.version == version for v in meta.versions):
            raise ValueError(f"版本不存在: {version}")
        meta.current_version = version
        meta.updated_at = now_str()
        storage.write_json(self._meta_path(name), meta.to_dict())
        return meta

    def remove_version(self, name: str, version: str) -> ProjectMeta:
        meta = self.get_project(name)
        if not meta:
            raise ValueError(f"项目不存在: {name}")
        if not any(v.version == version for v in meta.versions):
            raise ValueError(f"版本不存在: {version}")
        if len(meta.versions) == 1:
            raise ValueError("至少保留一个版本，不可删除")

        version_dir = self._versions_dir(name) / version
        if version_dir.exists():
            import shutil
            shutil.rmtree(version_dir, ignore_errors=True)

        meta.versions = [v for v in meta.versions if v.version != version]
        if meta.current_version == version:
            meta.current_version = meta.versions[0].version
        meta.updated_at = now_str()
        storage.write_json(self._meta_path(name), meta.to_dict())
        return meta

    def get_version_source_dir(self, name: str, version: str) -> Optional[Path]:
        d = self._versions_dir(name) / version / "source"
        return d if d.exists() else None

    def rename_project(self, name: str, new_name: str) -> ProjectMeta:
        meta = self.get_project(name)
        if not meta:
            raise ValueError(f"项目不存在: {name}")
        safe_new = storage.safe_name(new_name)
        if not safe_new:
            raise ValueError("新名称无效")
        if safe_new == name:
            return meta
        if self.exists(safe_new):
            raise ValueError(f"目标名称已存在: {safe_new}")

        old_dir = self._project_dir(name)
        new_dir = self._project_dir(safe_new)
        old_dir.rename(new_dir)

        meta.name = safe_new
        meta.updated_at = now_str()
        storage.write_json(new_dir / "metadata.json", meta.to_dict())
        return meta

    def update_version_description(
        self, name: str, version: str, description: str
    ) -> ProjectMeta:
        meta = self.get_project(name)
        if not meta:
            raise ValueError(f"项目不存在: {name}")
        for v in meta.versions:
            if v.version == version:
                v.description = description
                meta.updated_at = now_str()
                storage.write_json(self._meta_path(name), meta.to_dict())
                return meta
        raise ValueError(f"版本不存在: {version}")

    def replace_version_source(
        self, name: str, version: str, source_dir: Path
    ) -> ProjectMeta:
        meta = self.get_project(name)
        if not meta:
            raise ValueError(f"项目不存在: {name}")
        if not any(v.version == version for v in meta.versions):
            raise ValueError(f"版本不存在: {version}")

        source_target = self._versions_dir(name) / version / "source"
        import shutil
        if source_target.exists():
            shutil.rmtree(source_target, ignore_errors=True)
        source_target.mkdir(parents=True, exist_ok=True)

        file_count, total_size = storage.copy_tree_filtered(Path(source_dir), source_target)

        for v in meta.versions:
            if v.version == version:
                v.file_count = file_count
                v.total_size = total_size
                v.created_at = now_str()
                break
        meta.updated_at = now_str()
        storage.write_json(self._meta_path(name), meta.to_dict())
        return meta

    def copy_version(
        self,
        name: str,
        src_version: str,
        new_version: str,
        description: str = "",
        set_as_current: bool = True,
    ) -> ProjectMeta:
        meta = self.get_project(name)
        if not meta:
            raise ValueError(f"项目不存在: {name}")
        if not any(v.version == src_version for v in meta.versions):
            raise ValueError(f"源版本不存在: {src_version}")
        if any(v.version == new_version for v in meta.versions):
            raise ValueError(f"目标版本已存在: {new_version}")

        src_source = self._versions_dir(name) / src_version / "source"
        if not src_source.exists():
            raise ValueError(f"源版本源码不存在: {src_version}")

        self._add_version_internal(meta, src_source, new_version, description)
        if set_as_current:
            meta.current_version = new_version
        storage.write_json(self._meta_path(name), meta.to_dict())
        return meta

    def diff_versions(
        self, name: str, version_a: str, version_b: str
    ) -> Dict[str, Any]:
        meta = self.get_project(name)
        if not meta:
            raise ValueError(f"项目不存在: {name}")
        dir_a = self._versions_dir(name) / version_a / "source"
        dir_b = self._versions_dir(name) / version_b / "source"
        if not dir_a.exists():
            raise ValueError(f"版本不存在: {version_a}")
        if not dir_b.exists():
            raise ValueError(f"版本不存在: {version_b}")

        files_a = {str(p.relative_to(dir_a)).replace("\\", "/"): p for p in storage.iter_source_files(dir_a)}
        files_b = {str(p.relative_to(dir_b)).replace("\\", "/"): p for p in storage.iter_source_files(dir_b)}

        added = sorted(set(files_b.keys()) - set(files_a.keys()))
        removed = sorted(set(files_a.keys()) - set(files_b.keys()))
        modified = []
        unchanged = []
        for rel in sorted(set(files_a.keys()) & set(files_b.keys())):
            a_size = files_a[rel].stat().st_size
            b_size = files_b[rel].stat().st_size
            if a_size != b_size:
                modified.append(rel)
                continue
            try:
                a_text = files_a[rel].read_text(encoding="utf-8")
                b_text = files_b[rel].read_text(encoding="utf-8")
                if a_text == b_text:
                    unchanged.append(rel)
                else:
                    modified.append(rel)
            except UnicodeDecodeError:
                if a_size == b_size:
                    unchanged.append(rel)
                else:
                    modified.append(rel)

        return {
            "version_a": version_a,
            "version_b": version_b,
            "added": added,
            "removed": removed,
            "modified": modified,
            "unchanged_count": len(unchanged),
            "summary": {
                "added_count": len(added),
                "removed_count": len(removed),
                "modified_count": len(modified),
            },
        }

    def get_flow_notes(self, name: str) -> str:
        path = self._flow_path(name)
        if not path.exists():
            return ""
        return path.read_text(encoding="utf-8")

    def update_flow_notes(self, name: str, content: str) -> None:
        path = self._flow_path(name)
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(content, encoding="utf-8")
        meta = self.get_project(name)
        if meta:
            meta.updated_at = now_str()
            storage.write_json(self._meta_path(name), meta.to_dict())
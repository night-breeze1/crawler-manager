import io
import json
import shutil
import tempfile
import zipfile
from pathlib import Path

from flask import Blueprint, request, jsonify, current_app

from core.project_manager import ProjectManager
from core.version_manager import build_file_tree, read_source_file, flatten_tree
from core import storage

bp = Blueprint("projects", __name__)


def get_pm() -> ProjectManager:
    return current_app.config["PROJECT_MANAGER"]


def ok(data=None, message: str = "ok"):
    return jsonify({"code": 0, "message": message, "data": data})


def fail(message: str, code: int = 1, http: int = 400):
    return jsonify({"code": code, "message": message, "data": None}), http


@bp.route("/api/projects", methods=["GET"])
def list_projects():
    pm = get_pm()
    projects = [p.to_dict() for p in pm.list_projects()]
    for p in projects:
        p["total_size"] = sum(v["total_size"] for v in p["versions"])
        p["version_count"] = len(p["versions"])
    return ok(projects)


@bp.route("/api/projects/<name>", methods=["GET"])
def get_project(name: str):
    pm = get_pm()
    meta = pm.get_project(name)
    if not meta:
        return fail(f"项目不存在: {name}", http=404)
    data = meta.to_dict()
    data["total_size"] = sum(v["total_size"] for v in data["versions"])
    data["version_count"] = len(data["versions"])
    return ok(data)


@bp.route("/api/projects", methods=["POST"])
def create_project():
    pm = get_pm()
    name = (request.form.get("name") or "").strip()
    description = (request.form.get("description") or "").strip()
    tags_raw = (request.form.get("tags") or "").strip()
    initial_version = (request.form.get("initial_version") or "v1.0.0").strip()
    version_description = (request.form.get("version_description") or "").strip()
    tags = [t.strip() for t in tags_raw.split(",") if t.strip()] if tags_raw else []

    if not name:
        return fail("项目名称不能为空")

    files = request.files.getlist("files")
    has_files = any(f and f.filename for f in files)

    tmp_dir = None
    try:
        if has_files:
            tmp_dir = Path(tempfile.mkdtemp(prefix="cm_upload_"))
            for f in files:
                if not f or not f.filename:
                    continue
                rel = f.filename.replace("\\", "/")
                target = tmp_dir / rel
                target.parent.mkdir(parents=True, exist_ok=True)
                f.save(target)
            common_root = _find_common_root(tmp_dir)
            try:
                meta = pm.create_project(
                    name=name,
                    description=description,
                    tags=tags,
                    source_dir=common_root,
                    initial_version=initial_version,
                    version_description=version_description,
                )
            except ValueError as e:
                return fail(str(e))
        else:
            try:
                meta = pm.create_project(name=name, description=description, tags=tags)
            except ValueError as e:
                return fail(str(e))
        return ok(meta.to_dict(), message="创建成功")
    finally:
        if tmp_dir and tmp_dir.exists():
            shutil.rmtree(tmp_dir, ignore_errors=True)


@bp.route("/api/projects/<name>", methods=["PUT"])
def update_project(name: str):
    pm = get_pm()
    if not pm.exists(name):
        return fail(f"项目不存在: {name}", http=404)
    data = request.get_json(silent=True) or {}
    description = data.get("description")
    tags = data.get("tags")
    new_name = data.get("new_name")
    try:
        if new_name and storage.safe_name(new_name) != name:
            meta = pm.rename_project(name, new_name)
        else:
            meta = pm.update_project_meta(name, description=description, tags=tags)
    except ValueError as e:
        return fail(str(e))
    if description is not None or tags is not None:
        try:
            meta = pm.update_project_meta(meta.name, description=description, tags=tags)
        except ValueError as e:
            return fail(str(e))
    return ok(meta.to_dict(), message="更新成功")


@bp.route("/api/projects/<name>", methods=["DELETE"])
def delete_project(name: str):
    pm = get_pm()
    if not pm.delete_project(name):
        return fail(f"项目不存在: {name}", http=404)
    return ok(message="删除成功")


@bp.route("/api/projects/<name>/versions", methods=["GET"])
def list_versions(name: str):
    pm = get_pm()
    meta = pm.get_project(name)
    if not meta:
        return fail(f"项目不存在: {name}", http=404)
    return ok({
        "current_version": meta.current_version,
        "versions": [v.to_dict() for v in meta.versions],
    })


@bp.route("/api/projects/<name>/versions", methods=["POST"])
def add_version(name: str):
    pm = get_pm()
    if not pm.exists(name):
        return fail(f"项目不存在: {name}", http=404)

    version = (request.form.get("version") or "").strip()
    description = (request.form.get("description") or "").strip()
    if not version:
        return fail("版本号不能为空")

    files = request.files.getlist("files")
    if not any(f and f.filename for f in files):
        return fail("未上传任何文件")

    tmp_dir = Path(tempfile.mkdtemp(prefix="cm_ver_"))
    try:
        for f in files:
            if not f or not f.filename:
                continue
            rel = f.filename.replace("\\", "/")
            target = tmp_dir / rel
            target.parent.mkdir(parents=True, exist_ok=True)
            f.save(target)
        common_root = _find_common_root(tmp_dir)
        try:
            meta = pm.add_version(name, common_root, version, description)
        except ValueError as e:
            return fail(str(e))
        return ok(meta.to_dict(), message="版本添加成功")
    finally:
        shutil.rmtree(tmp_dir, ignore_errors=True)


@bp.route("/api/projects/<name>/versions/<version>", methods=["DELETE"])
def remove_version(name: str, version: str):
    pm = get_pm()
    try:
        meta = pm.remove_version(name, version)
    except ValueError as e:
        return fail(str(e), http=404)
    return ok(meta.to_dict(), message="版本已删除")


@bp.route("/api/projects/<name>/versions/<version>", methods=["PUT"])
def update_version(name: str, version: str):
    pm = get_pm()
    data = request.get_json(silent=True) or {}
    description = data.get("description")
    if description is None:
        return fail("无可更新字段")
    try:
        meta = pm.update_version_description(name, version, description)
    except ValueError as e:
        return fail(str(e), http=404)
    return ok(meta.to_dict(), message="版本说明已更新")


@bp.route("/api/projects/<name>/versions/<version>/replace", methods=["POST"])
def replace_version_source(name: str, version: str):
    pm = get_pm()
    if not pm.exists(name):
        return fail(f"项目不存在: {name}", http=404)

    files = request.files.getlist("files")
    if not any(f and f.filename for f in files):
        return fail("未上传任何文件")

    tmp_dir = Path(tempfile.mkdtemp(prefix="cm_replace_"))
    try:
        for f in files:
            if not f or not f.filename:
                continue
            rel = f.filename.replace("\\", "/")
            target = tmp_dir / rel
            target.parent.mkdir(parents=True, exist_ok=True)
            f.save(target)
        common_root = _find_common_root(tmp_dir)
        try:
            meta = pm.replace_version_source(name, version, common_root)
        except ValueError as e:
            return fail(str(e), http=404)
        return ok(meta.to_dict(), message="版本源码已替换")
    finally:
        shutil.rmtree(tmp_dir, ignore_errors=True)


@bp.route("/api/projects/<name>/versions/copy", methods=["POST"])
def copy_version(name: str):
    pm = get_pm()
    if not pm.exists(name):
        return fail(f"项目不存在: {name}", http=404)
    data = request.get_json(silent=True) or {}
    src_version = (data.get("src_version") or "").strip()
    new_version = (data.get("new_version") or "").strip()
    description = data.get("description") or ""
    set_as_current = bool(data.get("set_as_current", True))
    if not src_version or not new_version:
        return fail("源版本与目标版本均不能为空")
    try:
        meta = pm.copy_version(
            name, src_version, new_version, description, set_as_current
        )
    except ValueError as e:
        return fail(str(e), http=404)
    return ok(meta.to_dict(), message="版本复制成功")


@bp.route("/api/projects/<name>/versions/<version_a>/diff/<version_b>", methods=["GET"])
def diff_versions(name: str, version_a: str, version_b: str):
    pm = get_pm()
    try:
        result = pm.diff_versions(name, version_a, version_b)
    except ValueError as e:
        return fail(str(e), http=404)
    return ok(result)


@bp.route("/api/projects/<name>/versions/<version>/switch", methods=["POST"])
def switch_version(name: str, version: str):
    pm = get_pm()
    try:
        meta = pm.switch_version(name, version)
    except ValueError as e:
        return fail(str(e), http=404)
    return ok(meta.to_dict(), message="切换成功")


@bp.route("/api/projects/<name>/versions/<version>/tree", methods=["GET"])
def version_tree(name: str, version: str):
    pm = get_pm()
    source_dir = pm.get_version_source_dir(name, version)
    if not source_dir:
        return fail("版本不存在或无源码", http=404)
    tree = build_file_tree(source_dir, source_dir)
    return ok(tree.to_dict())


@bp.route("/api/projects/<name>/versions/<version>/file", methods=["GET"])
def version_file(name: str, version: str):
    pm = get_pm()
    source_dir = pm.get_version_source_dir(name, version)
    if not source_dir:
        return fail("版本不存在或无源码", http=404)
    rel_path = (request.args.get("path") or "").strip()
    if not rel_path:
        return fail("缺少 path 参数")
    result = read_source_file(source_dir, rel_path)
    if result is None:
        return fail("文件不存在", http=404)
    return ok(result)


@bp.route("/api/projects/<name>/flow", methods=["GET"])
def get_flow(name: str):
    pm = get_pm()
    if not pm.exists(name):
        return fail(f"项目不存在: {name}", http=404)
    return ok({"content": pm.get_flow_notes(name)})


@bp.route("/api/projects/<name>/flow", methods=["PUT"])
def update_flow(name: str):
    pm = get_pm()
    if not pm.exists(name):
        return fail(f"项目不存在: {name}", http=404)
    data = request.get_json(silent=True) or {}
    content = data.get("content", "")
    pm.update_flow_notes(name, content)
    return ok(message="保存成功")


@bp.route("/api/projects/<name>/versions/<version>/download", methods=["GET"])
def download_version(name: str, version: str):
    from flask import Response
    pm = get_pm()
    source_dir = pm.get_version_source_dir(name, version)
    if not source_dir:
        return fail("版本不存在或无源码", http=404)

    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zf:
        for f in storage.iter_source_files(source_dir):
            arcname = str(f.relative_to(source_dir)).replace("\\", "/")
            zf.write(f, arcname)
    buf.seek(0)
    headers = {
        "Content-Disposition": f'attachment; filename="{name}-{version}.zip"'
    }
    return Response(buf.getvalue(), mimetype="application/zip", headers=headers)


def _find_common_root(upload_root: Path) -> Path:
    entries = [p for p in upload_root.iterdir()]
    if len(entries) == 1 and entries[0].is_dir():
        return _find_common_root(entries[0])
    return upload_root
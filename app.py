import sys
from pathlib import Path

BASE_DIR = Path(__file__).resolve().parent
if str(BASE_DIR) not in sys.path:
    sys.path.insert(0, str(BASE_DIR))

from flask import Flask, render_template, send_from_directory, abort

from config import PROJECTS_DIR, MAX_CONTENT_LENGTH
from core.project_manager import ProjectManager
from api.projects import bp as projects_bp


def create_app() -> Flask:
    app = Flask(__name__, template_folder="templates", static_folder="static")
    app.config["MAX_CONTENT_LENGTH"] = MAX_CONTENT_LENGTH
    app.config["PROJECT_MANAGER"] = ProjectManager(PROJECTS_DIR)

    app.register_blueprint(projects_bp)

    @app.route("/")
    def index():
        return render_template("index.html")

    @app.route("/projects/<name>")
    def project_detail(name: str):
        return render_template("project_detail.html", project_name=name)

    @app.route("/projects/<name>/add-version")
    def add_version_page(name: str):
        return render_template("add_version.html", project_name=name)

    @app.route("/projects/<name>/flow")
    def flow_page(name: str):
        return render_template("flow_notes.html", project_name=name)

    @app.route("/projects/<name>/versions/<version>/browse")
    def browse_source(name: str, version: str):
        return render_template(
            "browse_source.html",
            project_name=name,
            version=version,
        )

    @app.route("/health")
    def health():
        return {"code": 0, "message": "ok"}

    return app


app = create_app()


if __name__ == "__main__":
    app.run(host="127.0.0.1", port=5000, debug=True)
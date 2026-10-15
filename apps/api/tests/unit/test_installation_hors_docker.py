"""Installation hors Docker (issue #142) : chemins calculés depuis le paquet.

Hors Docker, l'API ne vit pas dans /app : le dossier static et pyproject.toml doivent être
trouvés depuis l'emplacement du code (#144). Dans l'image, le code est dans /app/src, donc
les mêmes calculs donnent /app/static et /app/pyproject.toml.
"""

import tomllib
from pathlib import Path

API_DIR = Path(__file__).resolve().parents[2]


def pyproject_version() -> str:
    with open(API_DIR / "pyproject.toml", "rb") as f:
        version: str = tomllib.load(f)["project"]["version"]
        return version


def test_version_lue_depuis_pyproject() -> None:
    from src.config.version import get_version

    assert get_version() == pyproject_version()


def test_static_resolu_depuis_le_paquet() -> None:
    from src.main import app

    static = next(route for route in app.routes if getattr(route, "path", None) == "/static")
    assert Path(static.app.directory) == API_DIR / "static"  # type: ignore[attr-defined]

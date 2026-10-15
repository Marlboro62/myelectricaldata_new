"""uv.lock synchronisé avec pyproject.toml, et tenu à jour par semantic-release (issue #142).

Sans la version de pyproject.toml dans uv.lock, `uv sync --locked` échoue (installation hors
Docker). La règle semantic-release qui met uv.lock à jour est rejouée ici avec la sémantique
JavaScript de semantic-release-replace-plugin.
"""

import re
import tomllib
from pathlib import Path

import pytest
import yaml

API_DIR = Path(__file__).resolve().parents[2]
REPO_DIR = API_DIR.parent.parent
RELEASERC = REPO_DIR / ".releaserc.yaml"
UV_LOCK = "apps/api/uv.lock"


def pyproject_version() -> str:
    with open(API_DIR / "pyproject.toml", "rb") as f:
        version: str = tomllib.load(f)["project"]["version"]
        return version


def lock_root_version(lock: str) -> str:
    """Version du paquet racine dans uv.lock."""
    match = re.search(r'^name = "myelectricaldata-api"\nversion = "([^"]*)"', lock, re.M)
    assert match, "paquet myelectricaldata-api absent de uv.lock"
    return match.group(1)


def js_replace(pattern: str, to: str, text: str) -> tuple[str, int]:
    """`text.replace(new RegExp(pattern, "gm"), to)` en JavaScript, et le nombre de correspondances.

    Seuls `$&`, `$1`… et `$$` sont spéciaux dans `to` ; un `\\n` y reste littéral, comme en JS.
    """

    def expand(m: re.Match[str]) -> str:
        def token(d: re.Match[str]) -> str:
            return "$" if d[1] == "$" else m.group(0 if d[1] == "&" else int(d[1]))

        return re.sub(r"\$(\$|&|\d)", token, to)

    return re.subn(pattern, expand, text, flags=re.M)


def test_uv_lock_synchronise_avec_pyproject() -> None:
    assert lock_root_version((API_DIR / "uv.lock").read_text()) == pyproject_version()


@pytest.fixture
def releaserc() -> dict:
    if not RELEASERC.exists():
        pytest.skip(".releaserc.yaml absent (image Docker)")
    config: dict = yaml.safe_load(RELEASERC.read_text())
    return config


def plugin_options(config: dict, name: str) -> dict:
    options: dict = next(p[1] for p in config["plugins"] if isinstance(p, list) and p[0] == name)
    return options


def test_release_commite_uv_lock(releaserc: dict) -> None:
    assert UV_LOCK in plugin_options(releaserc, "@semantic-release/git")["assets"]


def test_release_met_a_jour_seulement_la_version_racine_de_uv_lock(releaserc: dict) -> None:
    replacements = plugin_options(releaserc, "semantic-release-replace-plugin")["replacements"]
    rule = next((r for r in replacements if UV_LOCK in r["files"]), None)
    assert rule, f"aucune règle semantic-release-replace-plugin pour {UV_LOCK}"

    lock = (API_DIR / "uv.lock").read_text()
    to = rule["to"].replace("${nextRelease.version}", "9.9.9")
    updated, count = js_replace(rule["from"], to, lock)

    assert count == 1
    assert lock_root_version(updated) == "9.9.9"
    changed = [(a, b) for a, b in zip(lock.splitlines(), updated.splitlines()) if a != b]
    assert len(updated.splitlines()) == len(lock.splitlines())
    assert changed == [(f'version = "{lock_root_version(lock)}"', 'version = "9.9.9"')]

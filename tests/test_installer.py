"""Installer round trip against temporary homes only: HOME and HERMES_HOME are always overridden."""
import json
import os
import subprocess
import sys
from pathlib import Path

import pytest
import yaml

REPO = Path(__file__).resolve().parent.parent
ID = "hermes-pickup"

# (name, original config bytes or None for no file, user edit applied after install, expected bytes
#  or None to compare with the original). Secrets in the originals must never be copied elsewhere.
CASES = [
    ("no plugins key, no final newline", b"model:\n  provider: x\n# keep me\napi_key: SECRET123", None, None),
    ("crlf with comments", b"model: x\r\n# keep me\r\napi_key: SECRET123\r\n", None, None),
    ("plugins braces with comment", b"a: 1\nplugins: {}  # mine\nb: 2\n", None, None),
    ("existing empty enabled list", b"plugins:\n  enabled: []  # mine\n  disabled: [x]\nb: 2\n", None, None),
    ("block list and other plugin", b"plugins:\n  enabled:\n    - other # mine\n  disabled: []\nb: 2\n", None, None),
    ("plugins block without enabled", b"plugins:\n  # note\n  extra: 1\nb: 2\n", None, None),
    ("empty enabled key", b"plugins:\n  enabled:\nb: 2\n", None, None),
    ("empty file", b"", None, None),
    ("no config file", None, None, None),
    ("user appended a key after install", b"a: 1\n# keep me\n",
     lambda t: t + b"later: 1\n", b"a: 1\n# keep me\nlater: 1\n"),
    ("user added a plugin inside our block", b"a: 1\n",
     lambda t: t.replace(b"- hermes-pickup\n", b"- hermes-pickup\n    - extra # theirs\n").replace(b"a: 1\n", b"# mine\na: 1\n"),
     b"# mine\na: 1\n\nplugins:\n  enabled:\n    - extra # theirs\n"),
]


def run(script, home, hermes_home, extra=None):
    env = {"PATH": os.environ["PATH"], "HOME": str(home), "HERMES_PYTHON": sys.executable}
    if hermes_home:
        env["HERMES_HOME"] = str(hermes_home)
    return subprocess.run(["bash", str(REPO / script)], env=env, capture_output=True, text=True, cwd=str(home))


def tree(root):
    return {str(p.relative_to(root)): p.read_bytes() for p in sorted(root.rglob("*")) if p.is_file()}


def meta(root):
    return {str(p.relative_to(root)): (p.stat().st_mode, p.stat().st_mtime_ns)
            for p in sorted(root.rglob("*")) if p.is_file()}


@pytest.mark.parametrize("name,original,edit,expected", CASES, ids=[c[0] for c in CASES])
def test_install_reinstall_uninstall_roundtrip(tmp_path, name, original, edit, expected):
    """Defect: uninstall leaves an installer-created plugins block (or drops comments, CRLF or the missing final
    newline), loses a user's own edits, copies secrets into a rollback record, or writes outside the target home.
    Only a real install -> reinstall -> uninstall run on a minimal config shows this."""
    home = tmp_path / "home"
    home.mkdir()
    hh = home / ".hermes" if name == "no config file" else tmp_path / "hermes-home"
    hh.mkdir(parents=True, exist_ok=True)
    cfg = hh / "config.yaml"
    state = hh / "pickup"
    state.mkdir()
    (state / "settings.json").write_text("{}")
    if original is not None:
        cfg.write_bytes(original)
    other = tmp_path / "elsewhere"
    other.mkdir()
    (other / "marker").write_text("untouched")
    # With HERMES_HOME unset the installer must land in $HOME/.hermes, not anywhere else.
    set_home = None if name == "no config file" else hh

    first = run("install.sh", home, set_home)
    assert first.returncode == 0, first.stderr
    assert ID in yaml.safe_load(cfg.read_text())["plugins"]["enabled"]
    after_first, meta_first = tree(hh), meta(hh)
    second = run("install.sh", home, set_home)
    assert second.returncode == 0 and tree(hh) == after_first  # idempotent, down to the ownership record
    assert meta(hh) == meta_first  # and no file was rewritten: same modes and mtimes
    owned = json.loads((hh / "plugins" / ID / ".config-owned.json").read_text())
    assert "SECRET123" not in json.dumps(owned) and set(owned) == {"plugin", "before", "after", "created_file"}

    if edit:
        cfg.write_bytes(edit(cfg.read_bytes()))
    gone = run("uninstall.sh", home, set_home)
    assert gone.returncode == 0, gone.stderr

    if original is None:
        assert not cfg.exists()
    elif expected is not None:
        assert cfg.read_bytes() == expected
    else:
        assert cfg.read_bytes() == original
        assert yaml.safe_load(cfg.read_text() or "{}") == yaml.safe_load(original.decode() or "{}")
    if name == "user added a plugin inside our block":  # owned lines were edited: only our id goes
        text = cfg.read_text()
        assert yaml.safe_load(text)["plugins"]["enabled"] == ["extra"] and "# theirs" in text and ID not in text
    assert not (hh / "plugins" / ID).exists() and not (hh / "desktop-plugins" / ID).exists()
    assert (state / "settings.json").read_text() == "{}"  # user state is kept
    assert tree(other) == {"marker": b"untouched"}
    assert {p.name for p in tmp_path.iterdir()} == {"home", "elsewhere", "hermes-home"} - ({"hermes-home"} if set_home is None else set())

"""Multi-profile safeguard for Hermes bug #134712 (Desktop backend drifts to another profile's config).
Temporary homes only: HOME and HERMES_HOME are always overridden."""
import os
import subprocess
import sys
from pathlib import Path

import yaml

REPO = Path(__file__).resolve().parent.parent
ID = "hermes-pickup"

PROFILES = {
    "alpha": b"# alpha keeps comments\nmodel:\n  default: y\nplugins:\n  enabled:\n    - usage-stats  # mine\n",
    "beta": b"plugins:\n  enabled: [hermes-pickup, other]\n",  # user enabled it themselves: never removed
    "gamma": b"model: z\r\napi_key: SECRET123\r\n",
}


def run(script, home, hh, all_profiles=None):
    env = {"PATH": os.environ["PATH"], "HOME": str(home), "HERMES_PYTHON": sys.executable, "HERMES_HOME": str(hh)}
    if all_profiles is not None:
        env["PICKUP_ALL_PROFILES"] = all_profiles
    return subprocess.run(["bash", str(REPO / script)], env=env, capture_output=True, text=True,
                          cwd=str(home), stdin=subprocess.DEVNULL)


def make_home(tmp_path):
    home = tmp_path / "home"
    home.mkdir()
    hh = tmp_path / "hermes-home"
    (hh / "profiles").mkdir(parents=True)
    (hh / "config.yaml").write_bytes(b"model:\n  default: x\n")
    for name, text in PROFILES.items():
        (hh / "profiles" / name).mkdir()
        (hh / "profiles" / name / "config.yaml").write_bytes(text)
    return home, hh


def enabled(path):
    return (yaml.safe_load(path.read_text()) or {}).get("plugins", {}).get("enabled") or []


def test_all_profiles_enable_and_exact_undo(tmp_path):
    """Defect: plugin enabled only in default 404s under the drift bug, or uninstall leaves our id in a
    profile, removes a user's own enable, or loses comments/CRLF/secrets placement."""
    home, hh = make_home(tmp_path)
    first = run("install.sh", home, hh, "1")
    assert first.returncode == 0, first.stderr
    assert "#134712" in first.stdout
    for name in PROFILES:
        assert ID in enabled(hh / "profiles" / name / "config.yaml"), name
    owners = hh / "plugins" / ID / ".config-owned-profiles"
    # beta already had it (user's own choice): no record, so uninstall never touches it
    assert sorted(p.name for p in owners.iterdir()) == ["alpha.json", "gamma.json"]
    assert "SECRET123" not in "".join(p.read_text() for p in owners.iterdir())

    second = run("install.sh", home, hh, "1")  # idempotent
    assert second.returncode == 0 and "added" not in second.stdout

    gone = run("uninstall.sh", home, hh)
    assert gone.returncode == 0, gone.stderr
    for name, text in PROFILES.items():
        assert (hh / "profiles" / name / "config.yaml").read_bytes() == text, name
    assert (hh / "config.yaml").read_bytes() == b"model:\n  default: x\n"
    assert not (hh / "plugins" / ID).exists()


def test_no_terminal_and_no_answer_leaves_profiles_alone(tmp_path):
    """Defect: a non-interactive install (CI, piped) silently edits every profile's config."""
    home, hh = make_home(tmp_path)
    out = run("install.sh", home, hh)
    assert out.returncode == 0, out.stderr
    assert "PICKUP_ALL_PROFILES=1" in out.stdout
    for name, text in PROFILES.items():
        assert (hh / "profiles" / name / "config.yaml").read_bytes() == text, name


def test_explicit_no(tmp_path):
    home, hh = make_home(tmp_path)
    out = run("install.sh", home, hh, "0")
    assert out.returncode == 0 and "left other profiles unchanged" in out.stdout
    for name, text in PROFILES.items():
        assert (hh / "profiles" / name / "config.yaml").read_bytes() == text, name


def test_warns_when_home_is_a_profile(tmp_path):
    """Defect: running from a shell inside a Hermes profile installs into that profile without saying so."""
    home, hh = make_home(tmp_path)
    env = {"PATH": os.environ["PATH"], "HOME": str(home), "HERMES_HOME": str(hh / "profiles" / "alpha")}
    out = subprocess.run(["bash", "-c", f'. "{REPO}/scripts/common.sh"; sleep() {{ :; }}; warn_if_profile_home'],
                         env=env, capture_output=True, text=True)
    assert "points at a profile folder" in out.stderr

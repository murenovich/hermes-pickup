"""Engine: one project per folder, however its path is spelled."""
import importlib.util
import sys
from pathlib import Path

CORE = Path(__file__).resolve().parent.parent / "core" / "pickup_core.py"


def load():
    spec = importlib.util.spec_from_file_location("pickup_core_dedupe", CORE)
    assert spec and spec.loader
    mod = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = mod  # dataclasses look their module up while the class is built
    spec.loader.exec_module(mod)
    return mod


def test_same_folder_spelled_two_ways_is_one_root(tmp_path):
    """Defect: on case-insensitive macOS a root found as both ~/Development/Projects and
    ~/Development/projects listed every project twice (duplicate chips on one card)."""
    core = load()
    real = tmp_path / "projects"
    real.mkdir()
    alias = tmp_path / "alias"
    alias.symlink_to(real)  # a second spelling of the same folder, portable to case-sensitive file systems
    assert core._unique_dirs([str(real), str(alias)]) == [str(real)]
    other = tmp_path / "other"
    other.mkdir()
    assert core._unique_dirs([str(real), str(other), str(alias)]) == [str(real), str(other)]
    assert core._unique_dirs([str(tmp_path / "missing"), str(tmp_path / "missing")]) == [str(tmp_path / "missing")]

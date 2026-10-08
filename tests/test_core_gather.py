"""Engine tests for v0.2.0: fair reading across profiles, skipped profiles, card limit.

Everything runs in a temp HOME and Hermes root with stub model hooks; nothing real is read.
"""
import importlib.util
import json
import sqlite3
import sys
import types
from pathlib import Path

import pytest

CORE = Path(__file__).resolve().parent.parent / "core" / "pickup_core.py"
NOW = 1_800_000_000.0


@pytest.fixture
def world(tmp_path, monkeypatch):
    """(core module, hermes root, add_chats) with HOME and the Hermes root inside tmp_path."""
    home, root = tmp_path / "home", tmp_path / "hermes"
    home.mkdir()
    root.mkdir()
    monkeypatch.setenv("HOME", str(home))
    spec = importlib.util.spec_from_file_location(f"pickup_core_{tmp_path.name}", CORE)
    core = importlib.util.module_from_spec(spec)
    monkeypatch.setitem(sys.modules, spec.name, core)
    spec.loader.exec_module(core)
    monkeypatch.setattr(core, "hermes_root", lambda: root)

    def add_chats(profile, specs):
        """specs: (id, title, minutes_ago[, assistant_text]); creates the profile directory and store."""
        folder = root if profile == "default" else root / "profiles" / profile
        folder.mkdir(parents=True, exist_ok=True)
        db = sqlite3.connect(folder / "state.db")
        db.executescript("""create table if not exists sessions (id text primary key, title text, source text,
            message_count int, started_at real, parent_session_id text);
            create table if not exists messages (id integer primary key, session_id text, role text, content text,
            tool_calls text, timestamp real);""")
        for sid, title, mins, *extra in specs:
            at = NOW - mins * 60
            db.execute("insert into sessions values (?,?,?,?,?,null)", (sid, title, "cli", 2, at))
            db.executemany("insert into messages (session_id, role, content, tool_calls, timestamp) values (?,?,?,?,?)",
                           [(sid, "user", f"help with {title}", None, at), (sid, "assistant", extra[0] if extra else "on it", None, at + 1)])
        db.commit()
        db.close()

    return core, root, home, add_chats


def ids(chats):
    return sorted(c["id"] for c in chats)


def test_fair_gather_across_profiles(world):
    """Defect: one busy profile fills the whole chat budget so quieter profiles' unfinished work never reaches a
    card; or a few newest excluded chats (or the old 24-row read cap) leave older eligible chats unread and
    max_chats=40 silently returns fewer. Live smoke on one machine cannot show either, and the
    older tests only run a single profile with a handful of chats."""
    core, root, home, add_chats = world
    add_chats("default", [(f"d{i}", f"secret plan {i}" if i <= 5 else f"busy {i}", i) for i in range(1, 51)])
    add_chats("alpha", [("a1", "alpha one", 120), ("a2", "alpha two", 130)])
    add_chats("beta", [("b1", "beta one", 180)])
    S = core.Settings
    by_profile = lambda chats: {p: sum(1 for c in chats if c["profile"] == p) for p in ("default", "alpha", "beta")}

    chats, errors = core.gather_chats(S(exclude=["secret"], max_chats=10, chats_per_profile=3), NOW)
    assert not errors and not any("secret" in c["title"] for c in chats)
    # quotas 3+2+1 reserved, 4 spare slots go to the newest remaining eligible chats (busy 6..9)
    assert by_profile(chats) == {"default": 7, "alpha": 2, "beta": 1}
    assert ids(chats) == sorted(["d6", "d7", "d8", "d9", "d10", "d11", "d12", "a1", "a2", "b1"])

    chats, _ = core.gather_chats(S(exclude=["secret"], max_chats=5, chats_per_profile=3), NOW)
    # over budget: the oldest non-last chat goes first (alpha's second), every profile keeps one
    assert by_profile(chats) == {"default": 3, "alpha": 1, "beta": 1} and "a2" not in ids(chats)

    chats, _ = core.gather_chats(S(max_chats=2, chats_per_profile=3), NOW)
    # more profiles than slots: max_chats is the hard bound, newest representatives win
    assert ids(chats) == ["a1", "d1"]

    chats, _ = core.gather_chats(S(exclude=["secret"], exclude_profiles=["alpha", "beta"], max_chats=40), NOW)
    # a lone profile fills max_chats, not its quota, and 5 hidden newest chats do not starve the rest:
    # 45 eligible (d6..d50), so max_chats=40 must return exactly the 40 newest, d6..d45 (past the old 24-row cap)
    assert ids(chats) == sorted(f"d{i}" for i in range(6, 46))


def test_skipped_profile_is_never_opened(world, monkeypatch):
    """Defect: a profile the user chose to skip is still opened, so its chat titles, errors or file paths
    leak into the model request (or add a project folder to the scan). The consent screen promises
    skipped profiles are not read; the API tests only compare evidence text, not which stores were opened."""
    core, root, home, add_chats = world
    add_chats("default", [("d1", "public work", 5)])
    add_chats("zz-skipped", [("p1", "private thing", 1, "edited ~/work/hiddenproj/notes.txt")])
    (home / "work" / "hiddenproj" / ".git").mkdir(parents=True)
    opened = []
    real = sqlite3.connect

    def guard(target, *a, **k):
        opened.append(str(target))
        if "/zz-skipped/" in str(target):
            raise sqlite3.OperationalError("skipped store opened")
        return real(target, *a, **k)

    monkeypatch.setattr(core.sqlite3, "connect", guard)
    result = core.catch_up(core.Settings(exclude_profiles=["zz-skipped"], include_files=False), now=NOW)
    assert opened and all("/zz-skipped/" not in p for p in opened)  # never even attempted
    assert result["errors"] == [] and "private thing" not in result["evidence"]
    assert not any("hiddenproj" in r or r.endswith("/work") for r in result["roots"])
    inventory = {p["name"]: p for p in core.profile_inventory(core.Settings(exclude_profiles=["zz-skipped"]))}
    assert inventory["zz-skipped"] == {"name": "zz-skipped", "has_session_store": True, "excluded": True}


def test_card_limit_prompt_parse_and_output_budget(world, monkeypatch):
    """Defect: the card limit is changed in settings but the prompt or parser still says 3, a bool or 0 passes
    as a limit, or a 10-card reply is cut off mid-JSON by the old fixed 4000-token budget and the refresh
    fails with "answer could not be understood". Existing tests use a canned one-card answer."""
    core, root, home, add_chats = world
    many = json.dumps({"threads": [{"title": f"Work {i}", "summary": "You were building.", "next": "Go", "prompt": "Go",
                                    "items": []} for i in range(12)]})
    add_chats("default", [("d1", "Landing page", 5)])
    for n in (1, 5, 10):
        assert f"At most {n} threads," in core.catch_up_instructions(n)
        assert len(core.parse_threads(many, {}, n)) == n
        sent = []  # wiring: the setting reaches the prompt the model gets and caps the returned threads
        result = core.catch_up(core.Settings(max_cards=n, include_files=False), now=NOW,
                               call_model=lambda ins, ev: sent.append(ins) or many)
        assert len(sent) == 1 and f"At most {n} threads," in sent[0] and len(result["threads"]) == n
    assert len(core.parse_threads(many, {})) == 5  # two-argument callers get the default
    assert core.catch_up_instructions(5) == core.CATCH_UP_INSTRUCTIONS
    for bad in ({"max_cards": 0}, {"max_cards": 11}, {"max_cards": True}, {"max_cards": "5"},
                {"chats_per_profile": 11}, {"max_chats": 41}, {"max_chats": 5.0}):
        with pytest.raises(ValueError):
            core.Settings(**bad)

    seen = {}
    agent = types.ModuleType("agent")
    oneshot = types.ModuleType("agent.oneshot")
    oneshot.run_oneshot = lambda **kw: seen.update(kw) or "{}"
    monkeypatch.setitem(sys.modules, "agent", agent)
    monkeypatch.setitem(sys.modules, "agent.oneshot", oneshot)
    core.hermes_oneshot("instructions", "evidence")  # the two-argument callback shape
    # Heuristic only, not a truncation guarantee: 10 max-length cards are ~2.2k characters each; assume a
    # pessimistic 3 characters per token and require the budget to exceed that estimate.
    assert seen["max_tokens"] >= 10 * 2200 // 3

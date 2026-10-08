"""Backend API tests. Run with Hermes's venv python: python -m pytest tests

Everything runs against a temporary HERMES_HOME and HOME with a fake model; no real chats, no real
model, nothing outside the temp dir is read or written.
"""
import importlib.util
import json
import sqlite3
import sys
import threading
import time
from pathlib import Path

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

API = Path(__file__).resolve().parent.parent / "dashboard" / "plugin_api.py"
PREFIX = "/api/plugins/hermes-pickup"

ANSWER = json.dumps({"threads": [{"title": "Landing page", "summary": "You were building a landing page.",
                                  "stopped": "Pricing section missing", "next": "Add pricing", "prompt": "Add pricing",
                                  "items": ["c1"]}]})


def seed_chat(home: Path, sid: str, title: str, msgs: list[tuple[str, str]] | None = None) -> None:
    db = sqlite3.connect(home / "state.db")
    db.executescript("""create table if not exists sessions (id text primary key, title text, source text,
        message_count int, started_at real, parent_session_id text);
        create table if not exists messages (id integer primary key, session_id text, role text, content text,
        tool_calls text, timestamp real);""")
    now = time.time()
    msgs = msgs or [("user", f"help me with {title}"), ("assistant", "on it")]
    db.execute("insert into sessions values (?,?,?,?,?,null)", (sid, title, "cli", len(msgs), now - 60))
    db.executemany("insert into messages (session_id, role, content, tool_calls, timestamp) values (?,?,?,?,?)",
                   [(sid, role, text, None, now - 60 + i) for i, (role, text) in enumerate(msgs)])
    db.commit()
    db.close()


@pytest.fixture
def env(tmp_path, monkeypatch):
    """Fresh plugin module (loaded by path, as the Hermes host does) on an isolated HERMES_HOME and HOME."""
    home = tmp_path / "hermes"
    home.mkdir()
    monkeypatch.setenv("HERMES_HOME", str(home))
    monkeypatch.setenv("HOME", str(tmp_path))
    spec = importlib.util.spec_from_file_location(f"pickup_api_{tmp_path.name}", API)
    api = importlib.util.module_from_spec(spec)
    monkeypatch.setitem(sys.modules, spec.name, api)  # the host registers before exec too
    spec.loader.exec_module(api)
    app = FastAPI()
    app.include_router(api.router, prefix=PREFIX)
    calls = []
    api._call_model = lambda instructions, evidence: calls.append(evidence) or ANSWER
    return api, TestClient(app), home, calls


def test_consent_gate_and_cache(env):
    """Defect: a refresh before consent sends private chat snippets to the model provider, or a
    garbled model answer is cached as "nothing to pick up" and wipes the user's last good cards.
    Live smoke runs after consent with a working model, so it sees neither."""
    api, c, home, calls = env
    seed_chat(home, "s1", "Landing page copy")

    assert c.post(f"{PREFIX}/refresh").status_code == 409
    assert c.post(f"{PREFIX}/consent", json={"accepted": False}).status_code == 422
    assert calls == [] and c.get(f"{PREFIX}/cards").json()["cards"] == []

    assert c.post(f"{PREFIX}/consent", json={"accepted": True}).json()["consent"]["given"] is True
    first = c.post(f"{PREFIX}/refresh").json()
    assert [x["title"] for x in first["cards"]] == ["Landing page"] and len(calls) == 1
    assert c.get(f"{PREFIX}/cards").json()["cards"] == first["cards"]
    assert len(calls) == 1  # /cards never calls the model

    api._call_model = lambda i, e: "sorry, I cannot help with that"
    assert c.post(f"{PREFIX}/refresh").status_code == 502
    assert c.get(f"{PREFIX}/cards").json()["cards"] == first["cards"]

    api._call_model = lambda i, e: ANSWER
    settings_file = home / "pickup" / "settings.json"
    good = settings_file.read_text()
    n = len(calls)
    # Corrupt file, or intact consent beside invalid settings (e.g. exclude list lost): both fail closed,
    # and saving settings does not quietly bring consent back.
    for broken in ("{not json", *(json.dumps({**json.loads(good), "settings": value})
                                  for value in ({"max_chats": "many"}, [], None, False))):
        settings_file.write_text(broken)
        assert c.get(f"{PREFIX}/status").json()["consent"]["given"] is False
        assert c.post(f"{PREFIX}/refresh").status_code == 409
        assert c.put(f"{PREFIX}/settings", json={"max_chats": 3}).status_code == 200
        assert c.get(f"{PREFIX}/status").json()["consent"]["given"] is False
        assert c.post(f"{PREFIX}/refresh").status_code == 409
    assert len(calls) == n


def test_settings_validation_and_consent_cannot_bypass_defaults(env):
    """Defect: PUT /settings accepts junk (bool as a number, NaN, relative roots) that later crashes the
    scan, or accepts a "consent" key that silently grants consent; and once consented, a refresh ignores
    the folder/word excludes, silently skips profiles by name, or loses explicit saved profile skips.
    Live smoke only uses valid settings and does not check persisted exclusion choices."""
    api, c, home, calls = env
    seed_chat(home, "s1", "Landing page copy")
    seed_chat(home, "s2", "Health tracker notes")
    profile = home / "profiles" / "medical"
    profile.mkdir(parents=True)
    seed_chat(profile, "s3", "Weekend reading list")
    fresh = c.get(f"{PREFIX}/settings").json()
    assert fresh["settings"]["exclude_profiles"] == fresh["defaults"]["exclude_profiles"] == []
    assert set(fresh["available_profiles"]) == {"default", "medical"}

    for bad in ('{"max_chats": true}', '{"chat_window_days": NaN}', '{"chat_window_days": -1}',
                '{"project_roots": ["relative/dir"]}', '{"exclude": "health"}', '{"include_files": null}',
                '{"consent": {"given": true, "at": 1}}'):
        r = c.put(f"{PREFIX}/settings", content=bad, headers={"content-type": "application/json"})
        assert r.status_code == 422, bad
    assert c.get(f"{PREFIX}/status").json()["consent"]["given"] is False
    assert c.post(f"{PREFIX}/refresh").status_code == 409

    c.post(f"{PREFIX}/consent", json={"accepted": True})
    assert c.post(f"{PREFIX}/refresh").status_code == 200
    assert "Landing page copy" in calls[-1] and "Health tracker" not in calls[-1]
    assert "Weekend reading list" in calls[-1]  # profile name alone must not hide a chat

    assert c.put(f"{PREFIX}/settings", json={"exclude_profiles": ["medical"]}).status_code == 200

    ok = c.put(f"{PREFIX}/settings", json={"exclude": [], "chat_window_days": 2})
    assert ok.status_code == 200 and ok.json()["settings"]["exclude"] == []
    assert c.get(f"{PREFIX}/status").json()["consent"]["given"] is True  # saving settings keeps consent
    saved = json.loads((home / "pickup" / "settings.json").read_text())
    assert saved["settings"]["exclude_profiles"] == ["medical"]
    assert c.get(f"{PREFIX}/settings").json()["settings"]["exclude_profiles"] == ["medical"]
    assert c.post(f"{PREFIX}/refresh").status_code == 200
    assert "Health tracker" in calls[-1]  # the user's explicit choice is honoured
    assert "Weekend reading list" not in calls[-1]  # partial PUT preserved the saved profile skip


def test_v011_files_load_without_losing_consent_or_skips(env):
    """Defect: after the 0.2.0 update, a 0.1.1 settings file (extra key this version does not know, a skip for a
    profile that no longer exists) fails validation, so consent is silently revoked or the saved skip is lost
    and the returning profile is read again; or the 3-card cache stops loading. Fresh-install tests cannot
    show this; only the invalid-known-value case is covered elsewhere."""
    api, c, home, calls = env
    seed_chat(home, "s1", "Landing page copy")
    state = home / "pickup"
    state.mkdir()
    (state / "settings.json").write_text(json.dumps({
        "version": 1, "consent": {"given": True, "at": 1700000000.0},
        "settings": {"max_chats": 8, "exclude_profiles": ["gone"], "exclude": ["health"], "retired_option": 7}}))
    old_cards = [{"title": f"Old {i}", "summary": "You were working.", "stopped": "x", "next": None, "items": []}
                 for i in range(3)]
    (state / "cache.json").write_text(json.dumps({"version": 1, "made_at": 1700000100.0, "cards": old_cards,
                                                  "counts": {"chats": 3, "projects": 0, "files": 0}}))

    status = c.get(f"{PREFIX}/status").json()
    assert status["consent"]["given"] is True and status["state_error"] is False
    assert status["settings"]["exclude_profiles"] == ["gone"] and status["settings"]["max_chats"] == 8
    assert (status["settings"]["max_cards"], status["settings"]["chats_per_profile"]) == (5, 3)
    assert c.get(f"{PREFIX}/cards").json()["cards"] == old_cards

    revived = home / "profiles" / "gone"  # the profile comes back: it must still be skipped
    revived.mkdir(parents=True)
    seed_chat(revived, "g1", "Revived profile chat")
    assert c.post(f"{PREFIX}/refresh").status_code == 200
    assert "Landing page copy" in calls[-1] and "Revived profile chat" not in calls[-1]


def test_card_and_profile_settings_roundtrip_and_errors(env):
    """Defect: the new limits save but are not returned/persisted, out-of-range or non-integer values are accepted
    (a bool or 11 cards then breaks the prompt), a mistyped profile name is saved and silently skips nothing,
    or a profile without a session store cannot be listed or skipped. Old tests cover the pre-0.2 fields only."""
    api, c, home, calls = env
    seed_chat(home, "s1", "Landing page copy")
    (home / "profiles" / "fresh").mkdir(parents=True)  # a profile directory with no state.db yet
    seed_chat_profile = home / "profiles" / "quiet"
    seed_chat_profile.mkdir(parents=True)
    seed_chat(seed_chat_profile, "q1", "Quiet profile chat")

    listed = c.get(f"{PREFIX}/profiles").json()["profiles"]
    assert listed == [{"name": "default", "has_session_store": True, "excluded": False},
                      {"name": "fresh", "has_session_store": False, "excluded": False},
                      {"name": "quiet", "has_session_store": True, "excluded": False}]

    good = {"max_cards": 10, "chats_per_profile": 2, "max_chats": 40, "exclude_profiles": ["fresh"]}
    assert c.put(f"{PREFIX}/settings", json=good).status_code == 200
    saved = json.loads((home / "pickup" / "settings.json").read_text())["settings"]
    assert {k: saved[k] for k in good} == good
    status = c.get(f"{PREFIX}/status").json()
    assert {k: status["settings"][k] for k in good} == good
    assert set(status["available_profiles"]) == {"default", "fresh", "quiet"}
    assert [p["excluded"] for p in c.get(f"{PREFIX}/profiles").json()["profiles"]] == [False, True, False]

    for field, value in (("max_cards", 0), ("max_cards", 11), ("max_cards", True), ("max_cards", "5"), ("max_cards", 5.0),
                         ("chats_per_profile", 11), ("max_chats", 41), ("exclude_profiles", ["frsh"])):
        r = c.put(f"{PREFIX}/settings", json={field: value})
        assert r.status_code == 422 and r.json()["detail"][0]["field"] == field, (field, value)
    assert json.loads((home / "pickup" / "settings.json").read_text())["settings"] == saved  # rejects change nothing


def test_concurrent_refresh_coalesces_and_recovers(env):
    """Defect: two refreshes (double click, two windows) each make a paid model call over the same private
    data, or a failed run leaves the "running" flag stuck so Refresh never works again.
    Live smoke clicks once, so it cannot see either."""
    api, c, home, calls = env
    seed_chat(home, "s1", "Landing page copy")
    c.post(f"{PREFIX}/consent", json={"accepted": True})
    entered, release, results = threading.Event(), threading.Event(), []

    def slow(instructions, evidence):
        calls.append(evidence)
        entered.set()
        release.wait(10)
        return ANSWER

    api._call_model = slow
    threads = [threading.Thread(target=lambda: results.append(c.post(f"{PREFIX}/refresh"))) for _ in range(2)]
    threads[0].start()
    assert entered.wait(10)
    threads[1].start()
    time.sleep(0.3)
    assert c.get(f"{PREFIX}/status").json()["refreshing"] is True
    release.set()
    for t in threads:
        t.join(15)
    assert [r.status_code for r in results] == [200, 200] and len(calls) == 1
    assert results[0].json() == results[1].json()

    def boom(instructions, evidence):
        raise RuntimeError("provider down")

    api._call_model = boom
    assert c.post(f"{PREFIX}/refresh").status_code == 502
    assert c.get(f"{PREFIX}/status").json()["refreshing"] is False
    api._call_model = lambda i, e: ANSWER
    assert c.post(f"{PREFIX}/refresh").status_code == 200


def test_exclusions_cover_every_emitted_field(env, tmp_path, monkeypatch):
    """Defect: an excluded word or folder is withheld from the chat title and latest asks but still reaches the
    model provider through the first message, last reply, todo step, Git branch/commit subject or a changed
    path (nested folder, rename, odd file name). Live smoke uses no exclusions and cannot see this; the
    consent screen promises the user's exclusions are honoured."""
    import os
    import subprocess

    api, c, home, calls = env
    for k, v in (("GIT_CONFIG_GLOBAL", os.devnull), ("GIT_CONFIG_NOSYSTEM", "1"), ("GIT_AUTHOR_NAME", "Tester"),
                 ("GIT_AUTHOR_EMAIL", "t@example.invalid"), ("GIT_COMMITTER_NAME", "Tester"),
                 ("GIT_COMMITTER_EMAIL", "t@example.invalid")):
        monkeypatch.setenv(k, v)

    proj = tmp_path / "work" / "allowed-project"
    proj.mkdir(parents=True)

    def g(*args):
        subprocess.run(["git", "-c", "core.hooksPath=/dev/null", "-C", str(proj), *args], check=True,
                       capture_output=True)

    g("init", "-q", "-b", "client-secretword")
    (proj / "old-secretword.txt").write_text("x")
    (proj / "tracked.txt").write_text("x")
    g("add", ".")
    g("commit", "-q", "-m", "Discuss secretword acquisition")
    g("mv", "old-secretword.txt", "renamed.txt")
    (proj / "private-subdir").mkdir()
    (proj / "private-subdir" / "notes.txt").write_text("x")
    (proj / "keep.txt").write_text("x")
    (proj / 'odd "name" file.txt').write_text("x")

    desktop = tmp_path / "Desktop"  # HOME is tmp_path: document evidence must also honour folder-name excludes
    desktop.mkdir()
    (desktop / "private-subdir-notes.txt").write_text("x")
    (desktop / "allowed-doc.txt").write_text("x")
    real_run = subprocess.run  # no Spotlight query: only Desktop/Downloads are scanned; Git still runs
    monkeypatch.setattr(subprocess, "run", lambda cmd, *a, **k: (_ for _ in ()).throw(OSError("no mdfind"))
                        if cmd[0] == "mdfind" else real_run(cmd, *a, **k))

    seed_chat(home, "s1", "Landing page copy")
    seed_chat(home, "first", "Quiet roadmap", [("user", "secretword acquisition details"), ("assistant", "ok"),
              ("user", "next"), ("assistant", "ok"), ("user", "more"), ("assistant", "done")])
    seed_chat(home, "last", "Budget notes", [("user", "hello"), ("assistant", "the secretword plan is ready")])
    seed_chat(home, "step", "Vendor chat", [("user", "go"), ("assistant", "working"),
              ("tool", json.dumps({"todos": [{"status": "in_progress", "content": "call secretword vendor"}]})),
              ("assistant", "ok")])
    named = home / "profiles" / "secretword-team"
    named.mkdir(parents=True)
    seed_chat(named, "t1", "Team standup")
    skipped = home / "profiles" / "medical"
    skipped.mkdir(parents=True)
    seed_chat(skipped, "m1", "Weekend reading list")

    saved = {"exclude": ["secretword", str(proj / "private-subdir")], "exclude_profiles": ["medical"],
             "project_roots": [str(tmp_path / "work")], "include_files": True}
    assert c.put(f"{PREFIX}/settings", json=saved).status_code == 200
    c.post(f"{PREFIX}/consent", json={"accepted": True})
    cite_all = json.dumps({"threads": [{"title": "Everything", "summary": "You were working.", "stopped": "x",
                                        "next": "Go", "prompt": "Go",
                                        "items": [f"{k}{n}" for k in "cp" for n in range(1, 9)]}]})
    api._call_model = lambda i, e: calls.append(e) or cite_all
    r = c.post(f"{PREFIX}/refresh")
    assert r.status_code == 200, r.text
    sent = calls[-1]

    assert "secretword" not in sent and "private-subdir" not in sent and "Discuss" not in sent
    assert "private-subdir-notes" not in sent
    for kept in ("Landing page copy", "Team standup", "allowed-project", "keep.txt", 'odd "name" file.txt',
                 "allowed-doc.txt"):
        assert kept in sent, kept
    # A rename whose old name is excluded is withheld whole, so the new name cannot point back at it.
    assert "renamed.txt" not in sent and "2 uncommitted changes" in sent
    assert "Weekend reading list" not in sent and "Quiet roadmap" not in sent
    assert "git branch (hidden)" in sent
    # The profile whose name is left out of the model text still owns its chat for routing.
    items = [i for card in r.json()["cards"] for i in card["items"]]
    assert any(i.get("profile") == "secretword-team" and i["ref"] == "t1" for i in items)

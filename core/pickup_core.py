"""Hermes Pickup core: "Pick up where you left off" for any Hermes install.

Setup-agnostic engine the desktop plugin backend will wrap. It discovers everything from the
Hermes install it runs in (Hermes home, profiles, session stores, project folders) and takes
everything personal from a settings file, never from code.

Adapted from Herald OS by Luke (iamlukethedev), MIT licence, https://github.com/iamlukethedev/Herald-OS
(evidence builder, transcript reader, cited-id parser and catch-up prompt; see ../reference/).

Read-only: SQLite opened with mode=ro, git with --no-optional-locks, no file contents read.
"""
from __future__ import annotations

import json
import os
import re
import sqlite3
import subprocess
import time
from dataclasses import dataclass, field
from datetime import datetime
from pathlib import Path

HOME = str(Path.home())
DAY = 86400

# Sources that are a person talking to Hermes. Everything else (cron, subagent, oneshot, kanban,
# custom batch sources) is treated as automation. Messaging platforms are read from Hermes itself
# when it is importable, so new platforms count automatically.
_LOCAL_SOURCES = {"cli", "tui", "desktop", "ios", "android", "hermes_os", "local", "api_server"}
_NOT_HUMAN = {"webhook", "msgraph_webhook", "wecom_callback", "relay"}


def human_sources() -> set[str]:
    sources = set(_LOCAL_SOURCES)
    try:
        from gateway.config import Platform  # type: ignore
        sources |= {p.value for p in Platform}
    except Exception:
        sources |= {"telegram", "discord", "slack", "whatsapp", "signal", "matrix", "mattermost", "email", "sms"}
    return sources - _NOT_HUMAN


# Inclusive (min, max) for the integer limits; the API enforces the same bounds.
LIMITS = {"max_cards": (1, 10), "chats_per_profile": (1, 10), "max_chats": (1, 40)}
DEFAULT_MAX_CARDS = 5


@dataclass
class Settings:
    """Everything user-specific. Defaults are safe for a fresh install."""
    file_window_days: float = 3
    project_window_days: float = 7
    chat_window_days: float = 3
    max_files: int = 16
    max_projects: int = 8
    max_chats: int = 20  # hard bound on chats selected as evidence, all profiles together (more transcripts may be scanned to find them)
    chats_read: int = 24  # legacy key, kept so old settings files load; no longer limits the scan
    max_cards: int = DEFAULT_MAX_CARDS
    chats_per_profile: int = 3  # quota reserved for each profile before spare slots are filled
    project_roots: list[str] = field(default_factory=list)  # empty = auto-detect
    exclude_profiles: list[str] = field(default_factory=list)
    exclude: list[str] = field(default_factory=list)  # folders (~/..., /...) or words
    skip_sessions: list[str] = field(default_factory=list)
    agent_identities: list[str] = field(default_factory=list)  # extra commit authors that are bots
    include_files: bool = True

    def __post_init__(self) -> None:
        self.validate()

    def validate(self) -> None:
        """Strict ints in range (bool is not an int here). Raises ValueError naming the field."""
        for name, (lo, hi) in LIMITS.items():
            v = getattr(self, name)
            if type(v) is not int or not lo <= v <= hi:
                raise ValueError(f"{name} must be a whole number from {lo} to {hi}")

    @classmethod
    def load(cls, path: str | None) -> "Settings":
        if not path or not os.path.exists(path):
            return cls()
        data = json.loads(Path(path).read_text())
        return cls(**{k: v for k, v in data.items() if k in cls.__dataclass_fields__})


# --- helpers ----------------------------------------------------------------------------------
def one_line(text: str, n: int) -> str:
    flat = re.sub(r"\s+", " ", text or "").strip()
    return flat if len(flat) <= n else flat[: n - 1].rstrip() + "…"


def tilde(p: str) -> str:
    return "~" + p[len(HOME):] if p == HOME or p.startswith(HOME + "/") else p


def when(ts: float, now: float) -> str:
    d, today = datetime.fromtimestamp(ts), datetime.fromtimestamp(now).date()
    days = (today - d.date()).days
    if days <= 0:
        return f"today {d:%H:%M}"
    if days == 1:
        return f"yesterday {d:%H:%M}"
    if days < 7:
        return f"{d:%A %H:%M}"
    return f"{d.day} {d:%b}"


def _norm(t: str) -> str:
    return re.sub(r"[\s._-]+", " ", (t or "").lower()).strip()


def is_excluded(text: str, exclude: list[str]) -> bool:
    """Herald's rule: a folder hides everything inside it and titles naming it; a word hides anything containing it."""
    if not text:
        return False
    hay = _norm(text)
    for raw in exclude:
        e = raw.strip()
        if not e:
            continue
        if e.startswith("/") or e == "~" or e.startswith("~/"):
            folder = (HOME + e[1:] if e.startswith("~") else e).rstrip("/") or "/"
            if text == folder or text.startswith(folder.rstrip("/") + "/"):  # "/" and "~" exclude every path under them
                return True
            if folder not in ("/", HOME):  # free text (a message, a reply) that names the folder
                forms = [folder] + (["~" + folder[len(HOME):]] if folder.startswith(HOME + "/") else [])
                if any(re.search(re.escape(f) + r"(?![\w@+-])", text) for f in forms):
                    return True
            name = _norm(folder.rsplit("/", 1)[-1])
            if len(name) >= 4 and not text.startswith("/") and name in hay:
                return True
        elif _norm(e) and _norm(e) in hay:
            return True
    return False


NOISE = {"node_modules", ".git", "dist", "build", "target", ".next", "__pycache__", "venv", ".venv"}


def noisy(p: str) -> bool:
    rel = p[len(HOME) + 1:] if p.startswith(HOME + "/") else p
    return any(s.startswith(".") or s in NOISE for s in rel.split("/"))


def git(args: list[str], cwd: str) -> tuple[int, str]:
    try:
        r = subprocess.run(["git", "--no-optional-locks", "-C", cwd, *args], capture_output=True, text=True, timeout=5)
        return r.returncode, r.stdout
    except Exception:
        return 1, ""


# --- Hermes install discovery -----------------------------------------------------------------
def hermes_root() -> Path:
    try:
        from hermes_constants import get_default_hermes_root  # type: ignore
        return Path(get_default_hermes_root())
    except Exception:
        return Path(os.environ.get("HERMES_HOME") or Path(HOME, ".hermes"))


def profile_inventory(settings: Settings | None = None) -> list[dict]:
    """Every profile of this install: "default" plus each profiles/<name> directory, whether or not it
    has a session store yet. Only directory entries and file existence are looked at, no store is opened.
    One inventory serves the valid skip names, GET /profiles and the stores that get read."""
    root = hermes_root()
    skipped = set(settings.exclude_profiles) if settings else set()
    names = ["default"]
    try:
        names += sorted(p.name for p in (root / "profiles").iterdir()
                        if p.is_dir() and not p.name.startswith(".") and p.name != "default")
    except OSError:
        pass
    return [{"name": n, "has_session_store": (root / "state.db" if n == "default"
                                              else root / "profiles" / n / "state.db").is_file(),
             "excluded": n in skipped} for n in names]


def session_stores(settings: Settings) -> list[tuple[str, Path]]:
    """Stores to read: skipped profiles are dropped here, before anything is opened."""
    root = hermes_root()
    return [(p["name"], root / "state.db" if p["name"] == "default" else root / "profiles" / p["name"] / "state.db")
            for p in profile_inventory(settings) if p["has_session_store"] and not p["excluded"]]


# --- evidence: conversations --------------------------------------------------------------------
INTERRUPTED = re.compile(r"^\s*operation interrupted\b", re.I)
PATH_RE = re.compile(r"(?:/Users/[^/\s\"']+|/home/[^/\s\"']+|~)(/[\w.@+-]+)+")


def text_of(content) -> str:
    if isinstance(content, str):
        s = content.strip()
        if s.startswith("["):
            try:
                v = json.loads(s)
                if isinstance(v, list):
                    return "\n".join(b.get("text", "") for b in v if isinstance(b, dict))
            except Exception:
                pass
        return content
    return ""


# Hermes injects its own notes as user-role messages (process notifications, compaction summaries,
# steering wrappers, gateway metadata). They are not the user's words.
_OOB = re.compile(r"\[OUT-OF-BAND USER MESSAGE[^\]]*\]\s*(.*?)\s*\[/OUT-OF-BAND USER MESSAGE\]", re.S)
_SYSTEM_NOTE = re.compile(r"^\s*\[(IMPORTANT|CONTEXT COMPACTION|Context from|SYSTEM|System|PRIOR CONTEXT|Note)\b")
_GATEWAY_META = re.compile(r"Gateway message origin \(JSON data.*?(?:\n\s*\n|$)", re.S)


def user_words(content) -> str:
    t = text_of(content)
    m = _OOB.search(t)
    if m:
        t = m.group(1)
    t = _GATEWAY_META.sub("", t)
    t = re.sub(r"Do not guess a reply destination[^\n]*", "", t)
    return "" if _SYSTEM_NOTE.match(t) else t.strip()


def read_transcript(msgs: list[dict]) -> dict:
    """Herald's readTranscript plus the user's own last words (long messaging chats drift topics)."""
    newest = msgs[-1] if msgs else None
    real = lambda m: text_of(m["content"]).strip() and not INTERRUPTED.match(text_of(m["content"]))
    last = next((m for m in reversed(msgs) if m["role"] == "assistant" and real(m)), None)
    asks = [one_line(w, 200) for w in (user_words(m["content"]) for m in msgs if m["role"] == "user") if w][-2:]
    step = None
    for m in reversed(msgs):
        if m["role"] == "tool" and '"todos"' in (m["content"] or ""):
            try:
                todos = json.loads(m["content"]).get("todos") or []
                t = next((t for t in todos if t.get("status") == "in_progress"), None) or \
                    next((t for t in todos if t.get("status") == "pending"), None)
                step = t and one_line(t.get("content", ""), 120)
            except Exception:
                pass
            break
    return {"at": newest["timestamp"] if newest else None, "last": last and one_line(text_of(last["content"]), 300),
            "asks": asks, "step": step,
            "stopped": bool(newest) and (newest["role"] != "assistant" or bool(INTERRUPTED.match(text_of(newest["content"]))))}


def chat_hidden(c: dict, exclude: list[str]) -> bool:
    """A chat is withheld whole if any text that build_catch_up can emit from it matches an exclusion."""
    return any(is_excluded(t, exclude) for t in (c["title"], c["first"], c["last"], c["step"], *c["asks"]))


def select_fair(by_profile: dict[str, list[dict]], max_chats: int, per_profile: int) -> list[dict]:
    """Pick at most max_chats from each profile's eligible chats (any order in, newest first out).

    1. Reserve each profile's newest `per_profile` chats.
    2. Over budget: drop the globally oldest reserved chat that is not its profile's last one, until it fits.
    3. Edge: more profiles than max_chats. The two rules cannot both hold, so max_chats wins and only the
       newest `max_chats` profile representatives (each profile's newest chat) stay; ties break on
       profile name then id, so the result is deterministic.
    4. Spare slots are filled with the newest remaining eligible chats from any profile (a single
       profile therefore fills max_chats, not just its quota)."""
    key = lambda c: (-c["at"], c["profile"], c["id"])  # sorts newest first; max() is the oldest
    ordered = {p: sorted(cs, key=key) for p, cs in by_profile.items() if cs}
    keep = {p: cs[:per_profile] for p, cs in ordered.items()}
    total = sum(len(v) for v in keep.values())
    while total > max_chats:
        trimmable = [v[-1] for v in keep.values() if len(v) > 1]
        if not trimmable:
            break
        keep[max(trimmable, key=key)["profile"]].pop()
        total -= 1
    chosen = [c for v in keep.values() for c in v]
    if len(chosen) > max_chats:
        chosen = sorted(chosen, key=key)[:max_chats]
    else:
        taken = {(c["profile"], c["id"]) for c in chosen}
        spare = sorted((c for cs in ordered.values() for c in cs if (c["profile"], c["id"]) not in taken), key=key)
        chosen += spare[: max_chats - len(chosen)]
    return sorted(chosen, key=key)


def _profile_chats(settings: Settings, profile: str, db: Path, sources: list[str], now: float, out: list[dict]) -> None:
    """Append this store's eligible chats (newest first) to `out`, at most settings.max_chats of them.
    Eligible = not skipped, not hidden by an exclusion, inside the window. The query has no row limit: rows
    are streamed newest first and the scan stops once enough eligible chats are found, so excluded
    newest chats cannot starve older eligible ones."""
    c = sqlite3.connect(f"file:{db}?mode=ro", uri=True)
    try:
        c.row_factory = sqlite3.Row
        cols = {r[1] for r in c.execute("pragma table_info(sessions)")}
        hidden = " and coalesce(hidden,0)=0" if "hidden" in cols else ""
        archived = " and coalesce(archived,0)=0" if "archived" in cols else ""
        last_col = "coalesce(last_activity_at, started_at)" if "last_activity_at" in cols else "started_at"
        # Hermes continues a long chat as a child session; keep only the newest link of each chain.
        q = f"""select id, title, source, message_count, {last_col} as at from sessions s
                where message_count > 0 {hidden}{archived}
                and not exists (select 1 from sessions k where k.parent_session_id = s.id and k.source = s.source)
                and source in ({",".join("?" * len(sources))}) and {last_col} > ?
                order by at desc"""
        found = 0
        for r in c.execute(q, [*sources, now - settings.chat_window_days * DAY]):
            if r["id"] in settings.skip_sessions:
                continue
            tail = [dict(m) for m in c.execute(
                "select role, content, tool_calls, timestamp from messages where session_id=? order by id desc limit 40",
                (r["id"],))][::-1]
            facts = read_transcript(tail[-12:])
            paths = set()
            for m in tail:
                for blob in (m.get("tool_calls") or "", m["content"] if m["role"] == "assistant" else ""):
                    paths.update(p.group(0) for p in PATH_RE.finditer(blob or ""))
            first = None
            if (r["message_count"] or 0) <= 40:
                row = c.execute("select content from messages where session_id=? and role='user' order by id limit 1",
                                (r["id"],)).fetchone()
                first = row and one_line(text_of(row[0]), 160)
            # Paths only feed "worked in" links and project-root detection: drop excluded ones.
            paths = {p for p in paths if not is_excluded(p.replace("~", HOME, 1) if p.startswith("~") else p,
                                                         settings.exclude)}
            chat = {"id": r["id"], "profile": profile, "source": r["source"], "title": r["title"] or "(untitled)",
                    "messages": r["message_count"], "at": max(r["at"] or 0, facts["at"] or 0), "first": first,
                    "paths": sorted(paths), **{k: facts[k] for k in ("last", "asks", "step", "stopped")}}
            if chat_hidden(chat, settings.exclude) or now - chat["at"] >= settings.chat_window_days * DAY:
                continue
            out.append(chat)
            found += 1
            if found >= settings.max_chats:
                break
    finally:
        c.close()


def gather_chats(settings: Settings, now: float) -> tuple[list[dict], list[dict]]:
    """Fair reading across profiles: see select_fair. Skipped profiles are never opened."""
    settings.validate()
    sources = sorted(human_sources())
    by_profile: dict[str, list[dict]] = {}
    errors = []
    for profile, db in session_stores(settings):
        found = by_profile.setdefault(profile, [])
        try:
            _profile_chats(settings, profile, db, sources, now, found)
        except Exception as e:  # one broken store must not hide the rest
            errors.append({"error": f"{profile}: {e}"})
    return select_fair(by_profile, settings.max_chats, settings.chats_per_profile), errors


# --- evidence: projects -------------------------------------------------------------------------
HERALD_ROOTS = ["Projects", "Apps", "Developer", "Code", "code", "src", "dev", "repos", "GitHub", "Documents/GitHub"]
SKIP_HOME_DIRS = {"Library", "Applications", "Movies", "Music", "Pictures", "Public", "Downloads", "Desktop"}
BOT_AUTHOR = re.compile(r"hermes|\bagent\b|\bbot\b|\[bot\]|claude|codex|copilot|cursor|openclaw|@local$|^noreply@|cron", re.I)


def _repo_count(folder: Path) -> int:
    try:
        return sum(1 for d in list(folder.iterdir())[:200] if d.is_dir() and (d / ".git").exists())
    except Exception:
        return 0


def detect_project_roots(chats: list[dict]) -> list[str]:
    """Folders whose children are projects: Herald's well-known roots, any folder one or two levels
    below home holding 2+ git repos, and the folder that holds a project a conversation worked in.
    Home itself is never a root (its children are Library, Dropbox...)."""
    roots = {str(Path(HOME, r)) for r in HERALD_ROOTS if Path(HOME, r).is_dir()}
    for lvl1 in Path(HOME).iterdir():
        if lvl1.name.startswith(".") or lvl1.name in SKIP_HOME_DIRS or not lvl1.is_dir():
            continue
        try:
            subs = [d for d in lvl1.iterdir() if d.is_dir() and not d.name.startswith(".")][:80]
        except Exception:
            continue
        for cand in [lvl1, *subs]:
            if _repo_count(cand) >= 2:
                roots.add(str(cand))
    for c in chats:
        for p in c["paths"]:
            p = Path(p.replace("~", HOME, 1) if p.startswith("~") else p)
            # Walk up to the folder directly below a known root, or to the nearest repo.
            top = p
            while top.parent != top and str(top.parent) != HOME and str(top.parent) not in roots \
                    and not (top / ".git").exists():
                top = top.parent
            parent = top.parent
            if str(parent) != HOME and parent != Path("/") and (top / ".git").exists() and _repo_count(top) < 2:
                roots.add(str(parent))
    return _unique_dirs(r for r in sorted(roots) if r != HOME and not noisy(r))


def _dir_key(path) -> tuple | str:
    """Identity of a folder on disk. On case-insensitive file systems (macOS default) `Projects` and
    `projects` are the same folder with different spellings, so compare device+inode, not strings."""
    try:
        st = os.stat(path)
        return (st.st_dev, st.st_ino)
    except OSError:
        return str(path)


def _unique_dirs(paths) -> list[str]:
    seen, out = set(), []
    for p in paths:
        k = _dir_key(p)
        if k not in seen:
            seen.add(k)
            out.append(str(p))
    return out


def gather_projects(settings: Settings, roots: list[str], now: float) -> list[dict]:
    my_email = (git(["config", "--global", "user.email"], HOME)[1] or "").strip().lower()
    cands = {}
    for root in roots:
        try:
            for d in Path(root).iterdir():
                # "_name" folders are conventionally meta (_archived, _registry), not projects.
                if d.is_dir() and not d.name.startswith((".", "_")) and not is_excluded(str(d), settings.exclude) \
                        and not is_excluded(d.name, settings.exclude):
                    cands.setdefault(_dir_key(d), d)  # one entry per folder, however it is spelled
        except Exception:
            pass
    rows = []
    for d in sorted(cands.values(), key=lambda p: -p.stat().st_mtime)[:60]:
        dm = d.stat().st_mtime
        if _repo_count(d) >= 2:  # an umbrella folder of projects, not a project
            continue
        if not (d / ".git").exists():
            try:
                newest = max([dm] + [c.stat().st_mtime for c in list(d.iterdir())[:60] if not c.name.startswith(".")])
            except Exception:
                newest = dm
            if newest >= now - settings.project_window_days * DAY:
                rows.append({"path": str(d), "name": d.name, "branch": None, "changed": [], "commits": [], "at": newest})
            continue
        code, st = git(["status", "--porcelain=v1", "-z", "--branch"], str(d))
        if code != 0:
            continue
        hidden = lambda rel: is_excluded(rel, settings.exclude) or is_excluded(str(d / rel.rstrip("/")), settings.exclude)
        branch, changed = None, []
        fields, i = st.split("\0"), 0  # -z: NUL-separated, never quoted; a rename is "XY new" then "old"
        while i < len(fields):
            entry, i = fields[i], i + 1
            if entry.startswith("## "):
                m = re.match(r"^No commits yet on (.+)$", entry[3:])
                branch = m.group(1) if m else entry[3:].split("...")[0].split(" ")[0]
                if is_excluded(branch, settings.exclude):
                    branch = "(hidden)"
            elif len(entry) > 3:
                old = None
                if entry[0] in "RC" or entry[1] in "RC":
                    old, i = (fields[i] if i < len(fields) else None), i + 1
                if not any(hidden(p) for p in (entry[3:], old) if p):
                    changed.append(entry[3:])
        _, lg = git(["log", "-3", "--format=%ct%x09%an%x09%ae%x09%s"], str(d))
        commits = []
        for l in lg.splitlines():
            parts = l.split("\t", 3)
            if len(parts) == 4 and not is_excluded(parts[3], settings.exclude):
                ident = f"{parts[1]} {parts[2]}"
                bot = (parts[2].lower() != my_email or not my_email) and (
                    bool(BOT_AUTHOR.search(parts[1]) or BOT_AUTHOR.search(parts[2]))
                    or any(a.lower() in ident.lower() for a in settings.agent_identities))
                commits.append({"at": int(parts[0]), "subject": parts[3][:140], "by_agent": bot})
        changed_at = 0
        for c in changed[:40]:
            try:
                changed_at = max(changed_at, (d / c).stat().st_mtime)
            except Exception:
                pass
        at = max(dm, commits[0]["at"] if commits else 0, changed_at)
        if at >= now - settings.project_window_days * DAY:
            rows.append({"path": str(d), "name": d.name, "branch": branch, "changed": changed, "commits": commits, "at": at})
    return sorted(rows, key=lambda r: -r["at"])[: settings.max_projects]


# --- evidence: documents ------------------------------------------------------------------------
def gather_files(settings: Settings, now: float) -> list[dict]:
    if not settings.include_files:
        return []
    since, rows = now - settings.file_window_days * DAY, {}
    for sub in ("Desktop", "Downloads"):
        try:
            for e in [e for e in Path(HOME, sub).iterdir() if not e.name.startswith(".")][:300]:
                st = e.stat()
                if st.st_mtime >= since and not is_excluded(str(e), settings.exclude) \
                        and not is_excluded(e.name, settings.exclude):
                    rows[str(e)] = {"path": str(e), "name": e.name, "at": st.st_mtime, "opened": False, "dir": e.is_dir()}
        except Exception:
            pass
    try:  # macOS recents; other systems simply have none here
        out = subprocess.run(["mdfind", "-onlyin", HOME, f"kMDItemLastUsedDate >= $time.now(-{int(now - since)})"],
                             capture_output=True, text=True, timeout=10).stdout.splitlines()
        for p in out[:80]:
            if "/Library/" in p or noisy(p) or is_excluded(p, settings.exclude) \
                    or is_excluded(os.path.basename(p), settings.exclude) or p in rows:
                continue
            rows[p] = {"path": p, "name": os.path.basename(p), "at": os.stat(p).st_mtime, "opened": True, "dir": os.path.isdir(p)}
    except Exception:
        pass
    return sorted(rows.values(), key=lambda r: -r["at"])[: settings.max_files]


# --- prompt ---------------------------------------------------------------------------------------
def catch_up_instructions(max_cards: int = DEFAULT_MAX_CARDS) -> str:
    return f"""You are the memory of the user's Hermes agent. You get evidence of what the user was recently doing: their conversations with Hermes, project folders and documents. Find the threads of work they will most likely want to pick up again.

Rules:
- At most {max_cards} threads, the one most worth resuming first. Fewer is fine, and an empty list is fine when nothing is worth resuming.
- Use only the evidence. Never invent files, people, deadlines or progress.
- Conversations are the strongest evidence of what the user cares about. A folder that only changed, with no conversation about it, rarely deserves a thread.
- Changes marked "by an agent" were made by the user's own automations or agents, not by the user. They are not unfinished work unless a conversation shows the user is waiting on them.
- Generated output (data dumps, reports, logs, builds, caches, screenshots, installers) is not work in progress.
- In long conversations only the latest messages matter: the title may describe an older topic, so name the thread from the user's latest messages.
- Only work and projects. Skip personal, emotional, health, family and money conversations unless the user was clearly building something.
- A thread groups the items of one piece of work. Link an item only when the evidence connects it: the same folder, a conversation that worked in that folder, or clearly the same subject.
- Favour unfinished work: a question Hermes has not finished answering, an unfinished step, a decision the user still owes, uncommitted changes the user made.
- Speak to the user as "you", plainly and briefly, without hype or technical terms such as model, response, session or tool.

Reply with JSON only, no prose and no code fence:
{{"threads":[{{"title":"","summary":"","stopped":"","next":"","prompt":"","items":[]}}]}}
- title: the work in 2 to 5 words, named the way the user would say it: the product, site or document, not a folder name when the evidence shows a better one.
- summary: one sentence starting with "You were", saying what the work is about.
- stopped: where it stopped, under 14 words, from the evidence: what was done last, or what is still open.
- next: the most useful next step Hermes can take now, 2 to 6 words, starting with a verb. Make it concrete ("Add an online ordering page"), never generic ("Continue the project"), and prefer a step that moves the work forward over one that only looks at it. If the next move is the user's decision, say so ("Decide on the build plan").
- prompt: the request the user would send Hermes to take that step: first person, specific, with the paths it needs.
- items: ids of the evidence entries that belong to the thread, like ["c1", "p2", "f3"]."""


CATCH_UP_INSTRUCTIONS = catch_up_instructions()


def build_catch_up(files, projects, chats, now: float, multi_profile: bool, exclude: list[str] = ()) -> tuple[str, dict]:
    refs, sections = {}, []
    # Profile and source names are display labels only (refs keep them for routing). If one names an
    # excluded value the label is left out of the model text, with no placeholder that could echo it.
    repo_of = {p["path"]: f"p{i}" for i, p in enumerate(projects, 1)}
    if chats:  # conversations first: they carry the most weight
        lines = []
        for i, c in enumerate(chats, 1):
            refs[f"c{i}"] = {"kind": "chat", "ref": c["id"], "label": c["title"], "profile": c["profile"], "source": c["source"]}
            who = f" with {c['profile']}" if multi_profile and not is_excluded(c["profile"], exclude) else ""
            via = f" via {c['source']}" if not is_excluded(c["source"], exclude) else ""
            parts = [f"c{i} \"{one_line(c['title'], 100)}\"{who}{via}, {when(c['at'], now)}, "
                     + (f"{c['messages']} messages" if c["messages"] > 1 else "asked but never answered")]
            if c["stopped"] and c["messages"] > 1:
                parts.append("stopped before Hermes finished")
            if c["step"]:
                parts.append(f"unfinished step: \"{c['step']}\"")
            if c["first"] and c["first"] != one_line(c["title"], 160):
                parts.append(f"it began: \"{c['first']}\"")
            if c["asks"]:
                parts.append("the user's latest messages: " + " / ".join(f"\"{a}\"" for a in c["asks"]))
            if c["last"]:
                parts.append(f"Hermes's last reply: \"{one_line(c['last'], 240)}\"")
            worked = sorted({repo_of[r] for r in repo_of for p in c["paths"]
                             if p.replace("~", HOME, 1).startswith(r + "/") or p.replace("~", HOME, 1) == r})
            if worked:
                parts.append("worked in " + ", ".join(worked))
            lines.append("; ".join(parts))
        sections.append("\n".join(["Hermes conversations", *lines]))
    if projects:
        lines = []
        for i, p in enumerate(projects, 1):
            refs[f"p{i}"] = {"kind": "project", "ref": p["path"], "label": p["name"]}
            if not p["branch"]:
                lines.append(f"p{i} {p['name']} ({tilde(p['path'])}): files changed {when(p['at'], now)}")
                continue
            n = len(p["changed"])
            inc = f", including {', '.join(p['changed'][:6])}" if n else ""
            changes = f"{n} uncommitted {'change' if n == 1 else 'changes'}{inc}" if n else "nothing uncommitted"
            commits = ", ".join(f"\"{one_line(c['subject'], 100)}\" ({when(c['at'], now)}{', by an agent' if c['by_agent'] else ''})"
                                for c in p["commits"])
            lines.append(f"p{i} {p['name']} ({tilde(p['path'])}): git branch {p['branch']}; {changes}"
                         + (f"; recent commits: {commits}" if commits else ""))
        sections.append("\n".join(["Projects", *lines]))
    if files:
        lines = []
        for i, f in enumerate(files, 1):
            refs[f"f{i}"] = {"kind": "folder" if f["dir"] else "file", "ref": f["path"], "label": f["name"]}
            lines.append(f"f{i} {f['name']} ({tilde(os.path.dirname(f['path']))}), "
                         f"{'opened' if f['opened'] else 'changed'} {when(f['at'], now)}")
        sections.append("\n".join(["Documents", *lines]))
    if not refs:
        return "", {}
    d = datetime.fromtimestamp(now)
    return "\n\n".join([f"Now: {d:%A} {d.day} {d:%B %Y}, {d:%H:%M}.", *sections]), refs


def parse_threads(text: str, refs: dict, max_cards: int = DEFAULT_MAX_CARDS) -> list[dict] | None:
    s, e = text.find("{"), max(text.rfind("}"), text.rfind("]"))
    try:
        data = json.loads(text[s:e + 1])
    except Exception:
        return None
    raw = data if isinstance(data, list) else data.get("threads") if isinstance(data, dict) else None
    if not isinstance(raw, list):
        return None
    out, seen = [], set()
    for t in raw:
        if not isinstance(t, dict) or len(out) >= max_cards:
            continue
        title, summary = one_line(str(t.get("title", "")), 60), one_line(str(t.get("summary", "")), 240)
        if not title or not summary or title.lower() in seen:
            continue
        seen.add(title.lower())
        ids = [str(i).strip() for i in (t.get("items") or [])]
        items = list({f"{refs[i]['kind']}:{refs[i]['ref']}": refs[i] for i in ids if i in refs}.values())[:6]
        label, prompt = one_line(str(t.get("next", "")), 48), one_line(str(t.get("prompt", "")), 1500)
        out.append({"title": title, "summary": summary, "stopped": one_line(str(t.get("stopped", "")), 160),
                    "next": {"label": label, "prompt": prompt} if label and prompt else None,
                    "items": items, "uncited": [i for i in ids if i not in refs]})
    return out


def catch_up(settings: Settings, now: float | None = None, call_model=None) -> dict:
    """Gather evidence, ask the model once, return cards plus everything needed to audit them."""
    settings.validate()
    now = now or time.time()
    t0 = time.time()
    chats, errors = gather_chats(settings, now)
    roots = settings.project_roots or detect_project_roots(chats)
    projects = gather_projects(settings, [r.replace("~", HOME, 1) for r in roots], now)
    files = gather_files(settings, now)
    profiles = {c["profile"] for c in chats}
    evidence, refs = build_catch_up(files, projects, chats, now, multi_profile=len(session_stores(settings)) > 1,
                                   exclude=settings.exclude)
    result = {"evidence": evidence, "refs": refs, "roots": roots, "errors": errors,
              "counts": {"chats": len(chats), "projects": len(projects), "files": len(files), "profiles": sorted(profiles)},
              "gather_s": round(time.time() - t0, 2), "threads": []}
    if not evidence or call_model is None:
        return result
    t1 = time.time()
    answer = call_model(catch_up_instructions(settings.max_cards), evidence)
    result.update(answer=answer, threads=parse_threads(answer, refs, settings.max_cards), model_s=round(time.time() - t1, 1))
    return result


def oneshot_budget(max_cards: int = LIMITS["max_cards"][1]) -> int:
    """Output tokens for a reply of up to max_cards cards (reasoning models spend some of it thinking).
    Never below the old fixed 4000."""
    return max(4000, 1000 + 1000 * max_cards)


def hermes_oneshot(instructions: str, user_input: str, max_cards: int = LIMITS["max_cards"][1]) -> str:
    """The same stateless call Hermes Desktop's llm.oneshot uses, on the install's own provider.
    The two-argument callback shape is kept, so every request is sized for the most cards allowed."""
    from agent.oneshot import run_oneshot  # type: ignore
    return run_oneshot(instructions=instructions, user_input=user_input, task="title_generation",
                       max_tokens=oneshot_budget(max_cards), temperature=0.2, timeout=150)

"""Hermes Pickup plugin: backend API routes.

Mounted at /api/plugins/hermes-pickup/ by the Hermes dashboard plugin system, which supplies
authentication. There is deliberately no standalone server here.

"Pick up where you left off": wraps ``pickup_core`` (adapted from Herald OS by Luke / iamlukethedev,
MIT, https://github.com/iamlukethedev/Herald-OS).

- Read-only toward the user's data. The only thing written is this plugin's own state folder,
  ``<hermes home>/pickup/`` (settings.json: consent and settings, cache.json: cards).
- No model call happens until the user has given consent via POST /consent.
- Only one refresh runs at a time; concurrent requests share the running one.
"""

from __future__ import annotations

import importlib.util
import json
import logging
import math
import os
import sys
import tempfile
import threading
import time
from pathlib import Path
from typing import Annotated, Any

from fastapi import APIRouter, Body, HTTPException
from pydantic import (BaseModel, ConfigDict, Field, StringConstraints, ValidationError, field_validator,
                      model_validator)

logger = logging.getLogger(__name__)

router = APIRouter()


# --- engine ---------------------------------------------------------------------------------------
def _load_core():
    """The host imports this file by path, so a relative import is not available. The installer puts
    pickup_core.py next to this file; in a source checkout it lives in ../core."""
    here = Path(__file__).resolve().parent
    for candidate in (here / "pickup_core.py", here.parent / "core" / "pickup_core.py"):
        if candidate.is_file():
            spec = importlib.util.spec_from_file_location("hermes_pickup_core", candidate)
            mod = importlib.util.module_from_spec(spec)
            sys.modules[spec.name] = mod
            spec.loader.exec_module(mod)
            return mod
    raise ImportError("pickup_core.py not found next to plugin_api.py")


core = _load_core()


def _call_model(instructions: str, user_input: str) -> str:
    return core.hermes_oneshot(instructions, user_input)


class _ModelError(Exception):
    pass


# --- state folder -----------------------------------------------------------------------------------
def _hermes_home() -> Path:
    try:
        from hermes_constants import get_hermes_home  # type: ignore
        return Path(get_hermes_home())
    except Exception:
        return Path(os.environ.get("HERMES_HOME") or Path.home() / ".hermes")


def _state_dir() -> Path:
    return _hermes_home() / "pickup"


def _write_json(path: Path, data: dict) -> None:
    """Atomic: a crash leaves the old file or the new one, never half of one."""
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    fd, tmp = tempfile.mkstemp(dir=path.parent, prefix=path.name + ".", suffix=".tmp")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            json.dump(data, f, indent=2, allow_nan=False)
            f.flush()
            os.fsync(f.fileno())
        os.chmod(tmp, 0o600)
        os.replace(tmp, path)
    except BaseException:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise


def _read_json(path: Path) -> tuple[dict | None, bool]:
    """(data, ok). Missing file is ok with no data; unreadable or non-object is not ok."""
    try:
        raw = path.read_text(encoding="utf-8")
    except FileNotFoundError:
        return None, True
    except OSError:
        return None, False
    try:
        data = json.loads(raw)
    except ValueError:
        return None, False
    return (data, True) if isinstance(data, dict) else (None, False)


# --- settings ---------------------------------------------------------------------------------------
# Generic sensitive-domain words are excluded from folders, chat titles and the user's own messages
# until the user changes the list. All profiles are included by default; saved profile exclusions
# remain effective, but v1 has no profile-skip UI.
DEFAULT_EXCLUDE = ["health", "medical", "finance", "nutrition", "inbox"]

_Text = Annotated[str, StringConstraints(max_length=500)]


def _clean_list(values: list[str], roots: bool = False) -> list[str]:
    out: list[str] = []
    for v in values:
        v = v.strip()
        if not v:
            continue
        if any(ord(c) < 32 or ord(c) == 127 for c in v):
            raise ValueError("control characters are not allowed")
        if roots and not (v.startswith("/") or v.startswith("~/")):
            raise ValueError("project roots must be absolute paths or start with ~/")
        if roots and v.rstrip("/") in ("", "~"):
            raise ValueError("a project root must be a folder that holds projects, not / or ~")
        if v not in out:
            out.append(v)
    if len(out) > 100:
        raise ValueError("at most 100 entries")
    return out


class SettingsUpdate(BaseModel):
    """Partial update of the user's settings. Unknown keys (consent included) are rejected."""
    model_config = ConfigDict(extra="forbid", strict=True)

    file_window_days: float | None = Field(None, gt=0, le=365, allow_inf_nan=False)
    project_window_days: float | None = Field(None, gt=0, le=365, allow_inf_nan=False)
    chat_window_days: float | None = Field(None, gt=0, le=365, allow_inf_nan=False)
    max_files: int | None = Field(None, ge=0, le=50)
    max_projects: int | None = Field(None, ge=1, le=20)
    max_chats: int | None = Field(None, ge=1, le=40)
    chats_read: int | None = Field(None, ge=1, le=100)  # legacy: accepted, no longer limits the scan
    max_cards: int | None = Field(None, ge=1, le=10)
    chats_per_profile: int | None = Field(None, ge=1, le=10)
    project_roots: list[_Text] | None = None
    exclude_profiles: list[_Text] | None = None
    exclude: list[_Text] | None = None
    skip_sessions: list[_Text] | None = None
    agent_identities: list[_Text] | None = None
    include_files: bool | None = None

    @model_validator(mode="after")
    def _no_nulls(self):
        for k in self.model_fields_set:
            if getattr(self, k) is None:
                raise ValueError(f"{k} cannot be null")
        return self

    @field_validator("exclude_profiles", "exclude", "skip_sessions", "agent_identities")
    @classmethod
    def _lists(cls, v):
        return v if v is None else _clean_list(v)

    @field_validator("project_roots")
    @classmethod
    def _roots(cls, v):
        return v if v is None else _clean_list(v, roots=True)


class ConsentRequest(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    accepted: bool


def _profiles(skipped: list[str] = ()) -> list[dict]:
    """The one profile inventory (names and whether a store exists; nothing is opened). Used for the
    valid skip names, GET /profiles and available_profiles."""
    try:
        return core.profile_inventory(core.Settings(exclude_profiles=list(skipped)))
    except Exception:
        return []


def _available_profiles() -> list[str]:
    return [p["name"] for p in _profiles()]


def _default_settings() -> dict[str, Any]:
    d = dict(vars(core.Settings()))
    d["exclude"] = list(DEFAULT_EXCLUDE)
    return d


def _load_stored(state: Path) -> tuple[dict, dict, bool]:
    """(consent, user-set settings, ok). Anything unreadable or invalid fails closed: no consent,
    default settings. A file whose settings were tampered with cannot keep a valid-looking consent,
    because the user consented to what the (now unknown) exclude list would have protected."""
    data, ok = _read_json(state / "settings.json")
    if not ok:
        return {}, {}, False
    data = data or {}
    consent = data.get("consent") if isinstance(data.get("consent"), dict) else {}
    saved = data.get("settings", {})
    if isinstance(saved, dict):  # keys this version does not know (older or newer file) are ignored, not fatal
        saved = {k: v for k, v in saved.items() if k in SettingsUpdate.model_fields}
    try:
        stored = SettingsUpdate.model_validate(saved).model_dump(exclude_unset=True)
    except Exception:
        return {}, {}, False
    return consent, stored, True


def _consent_state(consent: dict) -> dict:
    at = consent.get("at")
    given = consent.get("given") is True and isinstance(at, (int, float)) and not isinstance(at, bool) \
        and math.isfinite(at)
    return {"given": bool(given), "at": at if given else None}


def _save_stored(state: Path, consent: dict, stored: dict) -> None:
    _write_json(state / "settings.json", {"version": 1, "consent": consent, "settings": stored})


def _effective_settings(stored: dict) -> dict:
    return {**_default_settings(), **stored}


# --- cache --------------------------------------------------------------------------------------------
def _load_cache(state: Path) -> dict | None:
    data, ok = _read_json(state / "cache.json")
    if not ok or not data or not isinstance(data.get("cards"), list) or not isinstance(data.get("made_at"), (int, float)):
        return None
    return data


def _cards_payload(cache: dict | None) -> dict:
    if not cache:
        return {"cards": [], "made_at": None, "counts": None}
    return {"cards": cache["cards"], "made_at": cache["made_at"], "counts": cache.get("counts")}


# --- refresh: one at a time ---------------------------------------------------------------------------
class _Run:
    def __init__(self) -> None:
        self.done = threading.Event()
        self.payload: dict | None = None
        self.error: HTTPException | None = None


_lock = threading.Lock()
_running: dict[str, _Run] = {}  # keyed by state folder, so profiles do not block each other
_WAIT_S = 300


def _do_refresh(state: Path, effective: dict) -> dict:
    settings = core.Settings(**effective)

    def call(instructions: str, user_input: str) -> str:
        try:
            return _call_model(instructions, user_input)
        except Exception as e:
            logger.warning("pickup model call failed: %s", type(e).__name__)
            raise _ModelError(type(e).__name__) from e

    try:
        result = core.catch_up(settings, call_model=call)
    except _ModelError as e:
        raise HTTPException(502, f"The model call failed ({e}). Your previous cards were kept.")
    except Exception as e:
        logger.warning("pickup gather failed: %s", type(e).__name__)
        raise HTTPException(500, "Could not read your Hermes data. Your previous cards were kept.")
    if result["errors"] and not result["evidence"]:
        raise HTTPException(500, "Your Hermes session stores could not be read. Your previous cards were kept.")
    if "answer" in result and result["threads"] is None:
        raise HTTPException(502, "The model's answer could not be understood. Your previous cards were kept.")
    cards = [{k: t[k] for k in ("title", "summary", "stopped", "next", "items")} for t in result["threads"]]
    cache = {"version": 1, "made_at": time.time(), "cards": cards,
             "counts": {**result["counts"], "source_errors": len(result["errors"])}}
    _write_json(state / "cache.json", cache)
    return _cards_payload(cache)


def _refresh(state: Path, effective: dict) -> dict:
    key = str(state)
    with _lock:
        run = _running.get(key)
        owner = run is None
        if owner:
            run = _running[key] = _Run()
    if owner:
        try:
            run.payload = _do_refresh(state, effective)
        except HTTPException as e:
            run.error = e
        except Exception as e:
            logger.warning("pickup refresh failed: %s", type(e).__name__)
            run.error = HTTPException(500, "Refresh failed. Your previous cards were kept.")
        finally:
            with _lock:
                _running.pop(key, None)
            run.done.set()
    elif not run.done.wait(_WAIT_S):
        raise HTTPException(504, "A refresh is still running. Try again shortly.")
    if run.error:
        raise run.error
    return run.payload  # type: ignore[return-value]


# --- routes -------------------------------------------------------------------------------------------
def _settings_payload(stored: dict) -> dict:
    return {"settings": _effective_settings(stored), "defaults": _default_settings(),
            "available_profiles": _available_profiles()}


@router.get("/status")
def status():
    state = _state_dir()
    consent, stored, ok = _load_stored(state)
    cache = _load_cache(state)
    return {
        "consent": _consent_state(consent),
        "last_run": cache["made_at"] if cache else None,
        "counts": cache.get("counts") if cache else None,
        "refreshing": str(state) in _running,
        "settings": _effective_settings(stored),
        "available_profiles": _available_profiles(),
        "state_error": not ok,
    }


@router.post("/consent")
def give_consent(body: ConsentRequest):
    if not body.accepted:
        raise HTTPException(422, "Consent must be accepted explicitly.")
    state = _state_dir()
    with _lock:  # read-modify-write of settings.json is serialised
        consent, stored, _ = _load_stored(state)
        if not _consent_state(consent)["given"]:
            consent = {"given": True, "at": time.time()}
            _save_stored(state, consent, stored)
    return {"consent": _consent_state(consent)}


@router.post("/refresh")
def refresh():
    state = _state_dir()
    with _lock:  # consent check and settings snapshot are one step; the model call happens outside the lock
        consent, stored, _ = _load_stored(state)
        effective = _effective_settings(stored)
    if not _consent_state(consent)["given"]:
        raise HTTPException(
            409, "Consent is required first: Pickup sends chat snippets and project and file names to your "
                 "Hermes model provider. Confirm with POST /consent.")
    return _refresh(state, effective)


@router.get("/cards")
def cards():
    return _cards_payload(_load_cache(_state_dir()))


@router.get("/settings")
def get_settings():
    return _settings_payload(_load_stored(_state_dir())[1])


@router.get("/profiles")
def get_profiles():
    skipped = _effective_settings(_load_stored(_state_dir())[1])["exclude_profiles"]
    return {"profiles": _profiles(skipped)}


@router.put("/settings")
def put_settings(body: dict = Body(...)):
    # Validated by hand: FastAPI cannot serialise its own 422 when the rejected input is NaN/Infinity.
    try:
        update = SettingsUpdate.model_validate(body).model_dump(exclude_unset=True)
    except ValidationError as e:
        raise HTTPException(422, [{"field": ".".join(map(str, err["loc"])), "message": err["msg"]}
                                  for err in e.errors(include_input=False, include_url=False, include_context=False)])
    # Names are checked on save only: a skip saved for a profile that was later removed stays saved (and
    # applies again if the profile comes back), it is never rejected on load or dropped.
    unknown = [n for n in update.get("exclude_profiles", []) if n not in _available_profiles()]
    if unknown:
        raise HTTPException(422, [{"field": "exclude_profiles",
                                   "message": "Unknown profile: " + ", ".join(repr(n) for n in unknown)}])
    state = _state_dir()
    with _lock:
        # If the file was unreadable or invalid, consent comes back empty: saving settings never revives it.
        consent, stored, _ = _load_stored(state)
        stored = {**stored, **update}
        _save_stored(state, consent, stored)
    return _settings_payload(stored)

#!/usr/bin/env python3
"""Add or remove a plugin id in config.yaml's plugins.enabled, touching nothing else.

    config_edit.py enable|disable <plugin-id> <path/to/config.yaml> [<owner-file.json>]

Parses with PyYAML (never greps), edits the text line by line so comments, line endings (LF/CRLF) and
a missing final newline survive, then re-parses the result and refuses to write unless it equals the
intended data. Prints exactly what it did. Exit 0 = done or nothing to do, 2 = could not edit safely
(nothing written).

Rollback: with an owner file, `enable` records only the text span it changed ({"before", "after"}; never
the rest of the config). `disable` undoes exactly that span when it is still present once and the
re-parsed result is what removing the id should give; otherwise it falls back to removing just the id.
"""
from __future__ import annotations

import copy
import json
import os
import re
import sys
import tempfile

import yaml


def enabled_of(data) -> list:
    plugins = data.get("plugins") if isinstance(data, dict) else None
    enabled = plugins.get("enabled") if isinstance(plugins, dict) else None
    return enabled if isinstance(enabled, list) else []


def split_end(line: str) -> tuple[str, str]:
    body = line.rstrip("\r\n")
    return body, line[len(body):]


def block_end(lines: list[str], start: int) -> int:
    """Index after the last line of the top-level block that begins at lines[start]."""
    i = start + 1
    last = start
    while i < len(lines):
        s = lines[i]
        if s.strip() and not s.lstrip().startswith("#"):
            if not s[0].isspace():
                break
            last = i
        i += 1
    return last + 1


PLUGINS_RE = re.compile(r"^plugins:\s*(#.*)?$")
EMPTY_PLUGINS_RE = re.compile(r"^plugins:\s*\{\s*\}\s*(#.*)?$")
FLOW_ENABLED = re.compile(r"^(\s+enabled:\s*)\[([^\]#]*)\](\s*(?:#.*)?)$")


def find_plugins(lines: list[str], pattern) -> int | None:
    return next((i for i, s in enumerate(lines) if pattern.match(split_end(s)[0])), None)


def find_enabled(lines: list[str], plugins_at: int, end: int):
    """(index of the enabled: line, child indent) inside the plugins block, or (None, indent)."""
    child = next((re.match(r"^(\s+)\S", s).group(1) for s in lines[plugins_at + 1:end]
                  if s.strip() and not s.lstrip().startswith("#")), "  ")
    en_at = next((i for i in range(plugins_at + 1, end)
                  if re.match(rf"^{child}enabled:(\s|$)", lines[i])), None)
    return en_at, child


def block_items(lines: list[str], en_at: int, end: int) -> list[int]:
    """Indexes of the '- item' lines that belong to the block list under lines[en_at]."""
    item_re = re.compile(r"^(\s*)-\s")
    out, indent = [], None
    for j in range(en_at + 1, end):
        m = item_re.match(lines[j])
        if m and (indent is None or m.group(1) == indent):
            indent = m.group(1)
            out.append(j)
        elif lines[j].strip() and not lines[j].lstrip().startswith("#"):
            break
    return out


def unquote(item: str) -> str:
    item = item.strip()
    return item[1:-1] if len(item) >= 2 and item[0] == item[-1] and item[0] in "'\"" else item


def edit_enable(lines: list[str], plugin: str, data, eol: str) -> list[str] | None:
    plugins_at = find_plugins(lines, PLUGINS_RE)
    if plugins_at is None:
        empty = find_plugins(lines, EMPTY_PLUGINS_RE)
        if empty is not None:  # plugins: {}
            body, end = split_end(lines[empty])
            comment = re.search(r"#.*$", body)
            return [*lines[:empty], "plugins:" + (f" {comment.group(0)}" if comment else "") + end,
                    f"  enabled:{eol}", f"    - {plugin}{eol}", *lines[empty + 1:]]
        if isinstance(data, dict) and "plugins" in data:
            return None  # some other inline form: not edited by hand
        return [*lines, *([eol] if lines and lines[-1].strip() else []),
                f"plugins:{eol}", f"  enabled:{eol}", f"    - {plugin}{eol}"]
    end = block_end(lines, plugins_at)
    en_at, child = find_enabled(lines, plugins_at, end)
    if en_at is None:
        return [*lines[:plugins_at + 1], f"{child}enabled:{eol}", f"{child}  - {plugin}{eol}", *lines[plugins_at + 1:]]
    body, ending = split_end(lines[en_at])
    flow = FLOW_ENABLED.match(body)
    if flow:  # enabled: [a, b]  (also [])
        items = [i.strip() for i in flow.group(2).split(",") if i.strip()]
        return [*lines[:en_at], f"{flow.group(1)}[{', '.join([*items, plugin])}]{flow.group(3)}{ending}",
                *lines[en_at + 1:]]
    if not re.match(r"^\s+enabled:\s*(#.*)?$", body):
        return None  # some other inline value
    items = block_items(lines, en_at, end)
    if items:
        indent = re.match(r"^(\s*)", lines[items[-1]]).group(1)
        return [*lines[:items[-1] + 1], f"{indent}- {plugin}{eol}", *lines[items[-1] + 1:]]
    return [*lines[:en_at + 1], f"{child}  - {plugin}{eol}", *lines[en_at + 1:]]


def edit_disable(lines: list[str], plugin: str) -> list[str] | None:
    plugins_at = find_plugins(lines, PLUGINS_RE)
    if plugins_at is None:
        return None
    end = block_end(lines, plugins_at)
    en_at, _ = find_enabled(lines, plugins_at, end)
    if en_at is None:
        return None
    body, ending = split_end(lines[en_at])
    flow = FLOW_ENABLED.match(body)
    if flow:
        items = [i.strip() for i in flow.group(2).split(",") if i.strip()]
        kept = [i for i in items if unquote(i) != plugin]
        if len(kept) == len(items):
            return None
        return [*lines[:en_at], f"{flow.group(1)}[{', '.join(kept)}]{flow.group(3)}{ending}", *lines[en_at + 1:]]
    if not re.match(r"^\s+enabled:\s*(#.*)?$", body):
        return None
    pat = re.compile(rf"""^\s*-\s*(['"]?){re.escape(plugin)}\1\s*(#.*)?$""")
    items = block_items(lines, en_at, end)  # only this list: never plugins.disabled
    drop = {i for i in items if pat.match(split_end(lines[i])[0])}
    if not drop:
        return None
    out = [s for i, s in enumerate(lines) if i not in drop]
    if len(drop) == len(items):  # list is now empty: write [] rather than a null
        comment = re.search(r"#.*$", body)
        head = re.match(r"^(\s+enabled:)", body).group(1)
        out[en_at] = f"{head} []" + (f" {comment.group(0)}" if comment else "") + ending
    return out


def fragment(old: str, new: str) -> tuple[str, str]:
    """The smallest span of `old` that became `new`'s span. A change inside a line is widened to that
    whole line so the span is unambiguous; a pure insertion of lines stays exactly the inserted text."""
    n = min(len(old), len(new))
    a = 0
    while a < n and old[a] == new[a]:
        a += 1
    s = 0
    while s < n - a and old[-1 - s] == new[-1 - s]:
        s += 1
    b = len(old) - s
    left = right = ""
    mid = old[a:b] != "" or (0 < a < len(old) and old[a - 1] not in "\r\n" and old[a] not in "\r\n")
    if mid:
        left = old[old.rfind("\n", 0, a) + 1:a]
        stop = old.find("\n", b)
        right = old[b:len(old) if stop < 0 else stop + 1]
    return left + old[a:b] + right, left + new[a:len(new) - s] + right


def acceptable(candidate: str, data, enabled: list, plugin: str) -> bool:
    """Is `candidate` what the config should be once plugin is gone from plugins.enabled?"""
    try:
        got = yaml.safe_load(candidate) if candidate.strip() else {}
    except yaml.YAMLError:
        return False
    got = {} if got is None else got
    if not isinstance(got, dict):
        return False
    want = copy.deepcopy(data)
    want["plugins"]["enabled"] = [p for p in enabled if p != plugin]
    if got == want:
        return True
    if want["plugins"]["enabled"] == []:  # the installer may have created the block or the enabled key
        others = {k: v for k, v in want["plugins"].items() if k != "enabled"}
        rest = {k: v for k, v in got.items() if k != "plugins"}
        if rest != {k: v for k, v in want.items() if k != "plugins"}:
            return False
        return got.get("plugins") in (others, {**others, "enabled": None}) or (not others and got.get("plugins") in (None, {}))
    return False


def write_atomic(path: str, text: str) -> None:
    mode = os.stat(path).st_mode & 0o777 if os.path.exists(path) else 0o600
    fd, tmp = tempfile.mkstemp(dir=os.path.dirname(path) or ".", prefix=".config.yaml.", suffix=".tmp")
    try:
        with os.fdopen(fd, "w", encoding="utf-8", newline="") as f:  # newline="": keep CRLF as is
            f.write(text)
        os.chmod(tmp, mode)
        os.replace(tmp, path)
    except BaseException:
        if os.path.exists(tmp):
            os.unlink(tmp)
        raise


def read_owner(path: str | None, plugin: str) -> dict | None:
    try:
        rec = json.loads(open(path, encoding="utf-8").read()) if path else None
    except (OSError, ValueError):
        return None
    ok = isinstance(rec, dict) and rec.get("plugin") == plugin and isinstance(rec.get("before"), str) \
        and isinstance(rec.get("after"), str) and rec["after"]
    return rec if ok else None


def run_edit(edit, text: str, eol: str) -> str | None:
    """Apply a line edit to text; a file without a final newline gets one for the edit and loses it again."""
    padded = bool(text) and not text.endswith(("\n", "\r"))
    lines = edit((text + eol if padded else text).splitlines(keepends=True))
    if lines is None:
        return None
    out = "".join(lines)
    return out[:-len(eol)] if padded and out.endswith(eol) else out


def main(argv: list[str]) -> int:
    if len(argv) not in (4, 5) or argv[1] not in ("enable", "disable"):
        print(__doc__, file=sys.stderr)
        return 2
    action, plugin, path = argv[1:4]
    owner = argv[4] if len(argv) == 5 else None
    exists = os.path.exists(path)
    text = open(path, encoding="utf-8", newline="").read() if exists else ""
    found = re.search(r"\r?\n", text)
    eol = found.group(0) if found else "\n"
    try:
        data = yaml.safe_load(text) if text.strip() else {}
    except yaml.YAMLError as e:
        print(f"  ✗ {path} is not valid YAML ({type(e).__name__}); left untouched", file=sys.stderr)
        return 2
    if data is None:
        data = {}
    if not isinstance(data, dict):
        print(f"  ✗ {path} is not a YAML mapping; left untouched", file=sys.stderr)
        return 2

    enabled = enabled_of(data)
    disabled = (data.get("plugins") or {}).get("disabled") if isinstance(data.get("plugins"), dict) else None
    rec = None
    if action == "enable":
        if plugin in enabled:
            print(f"  ✓ {plugin} already in plugins.enabled; config.yaml unchanged")
            return 0
        if isinstance(disabled, list) and plugin in disabled:
            print(f"  ! {plugin} is listed in plugins.disabled; Hermes will not load it until you remove it there")
        new_text = run_edit(lambda ls: edit_enable(ls, plugin, data, eol), text, eol)
        want = copy.deepcopy(data)
        if not isinstance(want.get("plugins"), dict):
            want["plugins"] = {}
        want["plugins"]["enabled"] = [*enabled, plugin]
        done = f"added {plugin} to plugins.enabled in {path}" if exists else f"created {path} with {plugin} in plugins.enabled"
    else:
        if plugin not in enabled:
            print(f"  ✓ {plugin} not in plugins.enabled; config.yaml unchanged")
            return 0
        done = f"removed {plugin} from plugins.enabled in {path}"
        new_text, want = None, None
        rec = read_owner(owner, plugin)
        if rec and text.count(rec["after"]) == 1:  # exact undo of what install changed
            candidate = text.replace(rec["after"], rec["before"])
            if acceptable(candidate, data, enabled, plugin):
                new_text = candidate
        if new_text is None:  # user edited the owned lines: remove only our id
            rec = None
            new_text = run_edit(lambda ls: edit_disable(ls, plugin), text, eol)
            want = copy.deepcopy(data)
            want["plugins"]["enabled"] = [p for p in enabled if p != plugin]

    ok = False
    if new_text is not None:
        if want is None:  # exact undo was already parsed and checked
            ok = True
        else:
            try:
                ok = yaml.safe_load(new_text) == want
            except yaml.YAMLError:
                ok = False
    if not ok:
        print(f"  ✗ could not edit {path} safely (unusual layout); nothing written. "
              f"{'Add' if action == 'enable' else 'Remove'} '{plugin}' "
              f"{'to' if action == 'enable' else 'from'} plugins.enabled by hand.", file=sys.stderr)
        return 2

    if action == "enable":
        if owner:  # owner file first: if the config write fails it is removed again
            before, after = fragment(text, new_text)
            os.makedirs(os.path.dirname(owner) or ".", exist_ok=True)
            write_atomic(owner, json.dumps({"plugin": plugin, "before": before, "after": after,
                                            "created_file": not exists}))
        try:
            write_atomic(path, new_text)
        except BaseException:
            if owner and os.path.exists(owner):
                os.unlink(owner)
            raise
    else:
        if rec and rec.get("created_file") and not new_text.strip():
            os.unlink(path)
            done = f"removed {path} (it was created by the installer and is now empty)"
        else:
            write_atomic(path, new_text)
        if owner and os.path.exists(owner):
            os.unlink(owner)
    print(f"  ✓ {done}")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))

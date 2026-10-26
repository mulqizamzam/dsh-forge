#!/usr/bin/env python3
"""DSH plugin validator — dependency-free, fail-closed.

Checks the DSH contract for an installed plugin directory:
  * package.json exists and has dsh.bundle.patch === "./cordis.patch.yml"
  * cordis.patch.yml contains a top-level "insert:" block
  * lib/index.js exists and exports an apply symbol
  * no path traversal, symlinks, bytecode, or secret-shaped files
  * every SKILL.md (if present) has valid YAML frontmatter with non-empty name + description

Exit 0 on valid, 1 on invalid. --json emits the full report.
"""
from __future__ import annotations

import argparse
import json
import os
import re
import stat
import sys
from pathlib import Path

MAX_MEMBER = 5 * 1024 * 1024
MAX_ENTRIES = 2000
SECRET_BASENAME = re.compile(r"^(?:\.env(?:\..*)?|credentials?(?:\..*)?|secrets?(?:\..*)?|\.npmrc)$", re.I)
APPLY_EXPORT_RE = re.compile(r"\bexport\s+(?:async\s+)?(?:function\s+apply\b|const\s+apply\b|let\s+apply\b|var\s+apply\b|\{[^}]*\bapply\b[^}]*\})")
SKILL_FM_RE = re.compile(r"^---\s*\n(.*?)\n---", re.DOTALL)

def _walk(root: Path) -> tuple[list[Path], list[str]]:
    files: list[Path] = []
    errors: list[str] = []
    count = 0
    for current, dirs, names in os.walk(root, topdown=True, followlinks=False):
        cur = Path(current)
        for name in list(dirs):
            p = cur / name
            if name == '__pycache__':
                errors.append(f"transient Python bytecode cache is not allowed: {p.relative_to(root)}")
                dirs.remove(name)
                continue
            if p.is_symlink():
                errors.append(f"symlink is not allowed: {p.relative_to(root)}")
                dirs.remove(name)
        for name in names:
            p = cur / name
            rel = p.relative_to(root).as_posix()
            if '\\' in rel:
                errors.append(f"archive path must use /: {rel}")
            if p.is_symlink():
                errors.append(f"symlink is not allowed: {rel}")
                continue
            if not p.is_file():
                errors.append(f"unsupported member type: {rel}")
                continue
            size = p.stat().st_size
            if size > MAX_MEMBER:
                errors.append(f"file exceeds 5 MiB: {rel}")
            if SECRET_BASENAME.match(name):
                errors.append(f"secret-shaped file: {rel}")
            if name.endswith(('.pyc', '.pyo')):
                errors.append(f"transient bytecode: {rel}")
            files.append(p)
            count += 1
            if count > MAX_ENTRIES:
                errors.append(f"entry count exceeds {MAX_ENTRIES}")
                return files, errors
    return files, errors

def _parse_yaml_fm(text: str) -> dict | None:
    """Minimal YAML frontmatter parser — no external deps.

    Accepts: name: value, quoted strings, block scalar (>, |), plain values.
    Rejects: tabs (not allowed in indentation), explicit YAML tags.
    """
    if '\t' in text:
        return None
    try:
        m = SKILL_FM_RE.match(text)
        if not m:
            return None
        body = m.group(1)
        result: dict[str, object] = {}
        block_key: str | None = None
        block_lines: list[str] = []
        block_indent: int | None = None
        for line in body.splitlines():
            if block_key is not None:
                if line.strip() == '':
                    block_lines.append('')
                    continue
                indent = len(line) - len(line.lstrip(' '))
                if block_indent is None:
                    block_indent = indent
                if indent < block_indent:
                    result[block_key] = ('\n' if block_lines and block_lines[0] != '' else ' ').join(block_lines).strip()
                    block_key = None
                    block_lines = []
                    block_indent = None
                else:
                    block_lines.append(line[block_indent:])
                    continue
            if ':' not in line:
                continue
            key, _, value = line.partition(':')
            key = key.strip()
            value = value.strip()
            if value in ('|', '>', '|-', '>-'):
                block_key = key
                block_lines = []
                block_indent = None
                continue
            if value.startswith('!') or value.startswith('&') or value.startswith('*'):
                return None  # explicit tags/anchors rejected
            if value.startswith('"') and value.endswith('"') and len(value) >= 2:
                value = value[1:-1].replace('\\"', '"').replace('\\n', '\n')
            elif value.startswith("'") and value.endswith("'") and len(value) >= 2:
                value = value[1:-1].replace("''", "'")
            result[key] = value
        if block_key is not None:
            result[block_key] = ('\n' if block_lines and block_lines[0] != '' else ' ').join(block_lines).strip()
        return result
    except Exception:
        return None

def validate(root: Path) -> dict:
    errors: list[str] = []
    warnings: list[str] = []

    pkg_path = root / 'package.json'
    if not pkg_path.is_file():
        errors.append('missing package.json')
        return _report(root, errors, warnings, 'unknown')
    try:
        pkg = json.loads(pkg_path.read_text(encoding='utf-8'))
    except Exception as exc:
        errors.append(f'package.json is not valid JSON: {exc}')
        return _report(root, errors, warnings, 'unknown')

    name = pkg.get('name')
    version = pkg.get('version')
    if not isinstance(name, str) or not name:
        errors.append('package.json: "name" is required and non-empty')
    if not isinstance(version, str) or not re.match(r'^\d+\.\d+\.\d+', version):
        errors.append('package.json: "version" must be semver')
    dsh = pkg.get('dsh')
    if not isinstance(dsh, dict):
        errors.append('package.json: "dsh" object is required')
    else:
        bundle = dsh.get('bundle')
        if not isinstance(bundle, dict) or bundle.get('patch') != './cordis.patch.yml':
            errors.append('package.json: dsh.bundle.patch must be "./cordis.patch.yml"')

    patch = root / 'cordis.patch.yml'
    if not patch.is_file():
        errors.append('missing cordis.patch.yml')
    else:
        text = patch.read_text(encoding='utf-8')
        if 'insert:' not in text:
            errors.append('cordis.patch.yml must contain an "insert:" block')

    entry = root / 'lib/index.js'
    if not entry.is_file():
        # Fallback for source checkouts
        entry = root / 'src/host/index.ts'
    if not entry.is_file():
        errors.append('missing entry file: lib/index.js (or src/host/index.ts) is required')
    else:
        src = entry.read_text(encoding='utf-8')
        if not APPLY_EXPORT_RE.search(src):
            errors.append(f'{entry.relative_to(root)} must export an "apply" symbol')

    skills_root = root / 'skills'
    skill_count = 0
    if skills_root.is_dir():
        for child in sorted(skills_root.iterdir()):
            if not child.is_dir():
                continue
            skill_md = child / 'SKILL.md'
            if not skill_md.is_file():
                errors.append(f'skill directory missing SKILL.md: {child.name}')
                continue
            fm = _parse_yaml_fm(skill_md.read_text(encoding='utf-8'))
            if fm is None:
                errors.append(f'skill frontmatter is not valid YAML: {child.name}')
                continue
            fm_name = fm.get('name')
            fm_desc = fm.get('description')
            if not isinstance(fm_name, str) or not fm_name.strip():
                errors.append(f'skill frontmatter missing non-empty "name": {child.name}')
            if not isinstance(fm_desc, str) or not fm_desc.strip():
                errors.append(f'skill frontmatter missing non-empty "description": {child.name}')
            skill_count += 1

    _, walk_errors = _walk(root)
    errors.extend(walk_errors)

    return _report(root, errors, warnings, name or 'unknown', skill_count)

def _report(root: Path, errors: list[str], warnings: list[str], name: str, skills: int = 0) -> dict:
    return {
        'ok': not errors,
        'pluginRoot': str(root),
        'name': name,
        'skills': skills,
        'errors': errors,
        'warnings': warnings,
    }

def main() -> int:
    p = argparse.ArgumentParser(description='DSH plugin validator.')
    p.add_argument('plugin_root', nargs='?', default='.')
    p.add_argument('--json', action='store_true', dest='as_json')
    args = p.parse_args()
    report = validate(Path(args.plugin_root).expanduser().resolve())
    if args.as_json:
        print(json.dumps(report, indent=2, sort_keys=True))
    else:
        print('dsh plugin preflight: ' + ('PASS' if report['ok'] else 'FAIL'))
        print(f"name: {report['name']}; skills: {report['skills']}")
        for w in report['warnings']:
            print(f'warning: {w}')
        for e in report['errors']:
            print(f'error: {e}', file=sys.stderr)
    return 0 if report['ok'] else 1

if __name__ == '__main__':
    sys.exit(main())

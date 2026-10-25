#!/usr/bin/env python3
"""Read-only audit of a repository's AI-collaboration harness coverage.

Reports five pillars: instructions, skills, verification docs, evidence
tooling, and automation. Writes nothing. Exit code is 0 for a completed
audit (regardless of coverage), 2 for an invalid path.

Usage:
    python3 harness_audit.py [--root PATH] [--json] [--max-files N]
"""

from __future__ import annotations

import argparse
import json
import os
import sys
from pathlib import Path

SKIP_DIRS = {
    ".git", ".hg", ".svn", "node_modules", "vendor", "dist", "build",
    ".venv", "venv", "env", "__pycache__", ".next", ".nuxt", "target",
    ".idea", ".vscode", ".pytest_cache", ".mypy_cache", ".ruff_cache",
    "coverage", ".terraform", "Pods", "DerivedData",
}

INSTRUCTION_FILES = [
    "AGENTS.md", "CLAUDE.md", "GEMINI.md", ".cursorrules",
    ".windsurfrules", ".github/copilot-instructions.md",
]
INSTRUCTION_DIRS = [".cursor/rules", ".github/instructions"]

SKILL_DIRS = [
    ".agents/skills", ".cursor/skills", ".claude/skills",
    ".zcode/skills", "skills",
]

STACK_SIGNALS = [
    "package.json", "pyproject.toml", "setup.py", "go.mod", "Cargo.toml",
    "pom.xml", "build.gradle", "Gemfile", "composer.json", "Makefile",
    "justfile", "docker-compose.yml", "docker-compose.yaml", "Dockerfile",
    "requirements.txt", "mix.exs", "pubspec.yaml",
]

CI_FILES = [
    ".github/workflows", ".gitlab-ci.yml", ".circleci", "Jenkinsfile",
    "azure-pipelines.yml", ".buildkite", ".drone.yml",
]

VERIFY_KEYWORDS = ("verification", "acceptance", "harness", "验收", "验证")
EVIDENCE_KEYWORDS = ("evidence", "probe", "diagnos", "trace", "取证", "探针")

MAX_DEPTH = 6


def _prune(dirs):
    dirs[:] = [d for d in dirs if d not in SKIP_DIRS and not d.startswith(".git")]


def collect_files(root: Path, max_files: int) -> list[Path]:
    """Walk the tree with pruning; stop after max_files entries."""
    out: list[Path] = []
    for dirpath, dirnames, filenames in os.walk(root):
        _prune(dirnames)
        depth = len(Path(dirpath).relative_to(root).parts)
        if depth >= MAX_DEPTH:
            dirnames[:] = []
        for name in filenames:
            out.append(Path(dirpath) / name)
            if len(out) >= max_files:
                return out
    return out


def existing(root: Path, rels: list[str]) -> list[str]:
    return [r for r in rels if (root / r).exists()]


def find_signals(root: Path, names: list[str]) -> list[str]:
    """Detect build/runner files at the root or one level down (monorepos)."""
    hits = []
    for name in names:
        if (root / name).exists():
            hits.append(name)
            continue
        try:
            children = sorted(p for p in root.iterdir()
                              if p.is_dir() and p.name not in SKIP_DIRS
                              and not p.name.startswith("."))
        except OSError:
            children = []
        for child in children:
            if (child / name).exists():
                hits.append(f"{child.name}/{name}")
    return hits


def find_named(files: list[Path], root: Path, keywords: tuple[str, ...],
               suffixes: tuple[str, ...] | None = None) -> list[str]:
    """Match keywords against the full relative path, not just the basename,
    so docs living in an `acceptance/` directory are found."""
    hits = []
    for f in files:
        rel = f.relative_to(root)
        if suffixes and not f.name.lower().endswith(suffixes):
            continue
        hay = str(rel).lower()
        if any(k in hay for k in keywords):
            hits.append(str(rel))
    return sorted(hits)


def under_skill_dir(rel: Path) -> bool:
    """Skill definitions are not project verification assets."""
    s = str(rel)
    return any(s == d or s.startswith(d + "/") for d in SKILL_DIRS)


def project_docs(files: list[Path], root: Path) -> list[Path]:
    return [f for f in files if not under_skill_dir(f.relative_to(root))]


def has_tests(files: list[Path], root: Path) -> list[str]:
    hits = []
    for f in files:
        parts = set(f.relative_to(root).parts[:-1])
        name = f.name.lower()
        if parts & {"tests", "test", "__tests__", "spec", "e2e"}:
            hits.append(str(f.relative_to(root)))
        elif name.startswith("test_") or name.endswith(
            ("_test.py", "_test.go", ".test.ts", ".test.js", ".spec.ts", ".spec.js")
        ):
            hits.append(str(f.relative_to(root)))
        if len(hits) >= 20:
            break
    return hits


def instruction_links(root: Path) -> list[str]:
    """Check whether the instruction file indexes verification assets."""
    found = []
    for rel in INSTRUCTION_FILES + ["AGENTS.md", "CLAUDE.md"]:
        p = root / rel
        if not p.is_file():
            continue
        try:
            text = p.read_text(encoding="utf-8", errors="ignore").lower()
        except OSError:
            continue
        for needle in ("docs/agent", "acceptance", "evidence", "verification"):
            if needle in text:
                found.append(f"{rel} -> {needle}")
    return sorted(set(found))


def status_from(primary: bool, secondary: bool) -> str:
    if primary and secondary:
        return "present"
    if primary or secondary:
        return "partial"
    return "missing"


def audit(root: Path, max_files: int = 20000) -> dict:
    files = collect_files(root, max_files)

    instr_files = existing(root, INSTRUCTION_FILES)
    instr_dirs = existing(root, INSTRUCTION_DIRS)
    instructions = instr_files + instr_dirs

    skill_hits = []
    for d in existing(root, SKILL_DIRS):
        count = sum(1 for f in (root / d).rglob("SKILL.md")
                    if not (set(f.parts) & SKIP_DIRS))
        skill_hits.append({"path": d, "skills": count})

    verify_docs = find_named(project_docs(files, root), root, VERIFY_KEYWORDS)
    tests = has_tests(files, root)
    evidence = find_named(project_docs(files, root), root, EVIDENCE_KEYWORDS)

    ci = existing(root, CI_FILES)
    runners = find_signals(root, ["Makefile", "justfile", "package.json", "pyproject.toml"])
    has_runner = bool(runners)

    pillars = {
        "instructions": {
            "status": "present" if instructions else "missing",
            "found": instructions,
            "gap": "" if instructions else
                   "没有 agent 入口文件，下一个会话无处读取约定",
        },
        "skills": {
            "status": "present" if skill_hits else "missing",
            "found": skill_hits,
            "gap": "" if skill_hits else
                   "没有可复用的过程知识目录（规则之外的操作手册）",
        },
        "verification": {
            "status": status_from(bool(verify_docs), bool(tests)),
            "found": {"docs": verify_docs[:20], "tests": tests[:20]},
            "gap": "" if (verify_docs and tests) else
                   "缺少可复跑的验收文档或测试之一，无法证明改动有效",
        },
        "evidence": {
            "status": "present" if evidence else "missing",
            "found": evidence[:20],
            "gap": "" if evidence else
                   "没有现象→证据的映射或取证脚本，排障靠人记忆",
        },
        "automation": {
            "status": status_from(bool(ci), bool(has_runner)),
            "found": {"ci": ci, "runner": runners},
            "gap": "" if (ci or has_runner) else
                   "没有 CI 或统一命令入口，判定无法自动执行",
        },
    }

    score = sum({"present": 1.0, "partial": 0.5, "missing": 0.0}[p["status"]]
                for p in pillars.values())

    return {
        "root": str(root),
        "files_scanned": len(files),
        "stack_signals": find_signals(root, STACK_SIGNALS),
        "pillars": pillars,
        "instruction_index": instruction_links(root),
        "score": round(score, 1),
        "score_max": 5,
    }


NEXT_ACTIONS = {
    "instructions": "新建 AGENTS.md：跑法、验证索引、证据位置、禁区。",
    "skills": "把已重复三次以上的操作写成 SKILL.md（见 references/knowledge-layers.md）。",
    "verification": "选一条最常手工验的路径，写 docs/agent/verification-loop.md 与可跑检查。",
    "evidence": "补 docs/agent/evidence-map.md 与按 session 聚合的取证脚本。",
    "automation": "把判定接进 CI 或统一命令入口，保证每次改动都会跑。",
}

RANK = {"missing": 0, "partial": 1, "present": 2}


def render(report: dict) -> str:
    lines = [
        "Project Harness Audit",
        f"root: {report['root']}",
        f"files scanned: {report['files_scanned']}",
        f"stack signals: {', '.join(report['stack_signals']) or '(none detected)'}",
        "",
        "PILLARS",
    ]
    label = {"present": "OK  ", "partial": "PART", "missing": "MISS"}

    def summarize(name: str, p: dict) -> str:
        found = p["found"]
        if name == "skills":
            return ", ".join(f"{d['path']} ({d['skills']})" for d in found) or "-"
        if name == "verification":
            return f"docs={len(found['docs'])}, tests={len(found['tests'])}"
        if name == "automation":
            return f"ci={'yes' if found['ci'] else 'no'}, runner={len(found['runner'])} file(s)"
        if isinstance(found, list):
            if not found:
                return "-"
            head = ", ".join(found[:3])
            return head + (f" (+{len(found) - 3})" if len(found) > 3 else "")
        return str(found)

    for name, p in report["pillars"].items():
        lines.append(f"  [{label[p['status']]}] {name:<14} {summarize(name, p)}")

    lines += ["", f"SCORE: {report['score']} / {report['score_max']}"]

    idx = report["instruction_index"]
    lines.append(f"INDEX LINKS: {', '.join(idx) if idx else '(none)'}")

    gaps = [(n, p) for n, p in report["pillars"].items() if p["status"] != "present"]
    if gaps:
        lines += ["", "NEXT ACTIONS (weakest first)"]
        gaps.sort(key=lambda kv: RANK[kv[1]["status"]])
        for i, (name, p) in enumerate(gaps, 1):
            lines.append(f"  {i}. {name}: {p['gap'] or NEXT_ACTIONS[name]}")
    else:
        lines += ["", "All pillars covered. Move to the next user path."]

    return "\n".join(lines)


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description="Read-only harness coverage audit")
    ap.add_argument("--root", default=".", help="repository root (default: .)")
    ap.add_argument("--json", action="store_true", help="emit JSON")
    ap.add_argument("--max-files", type=int, default=20000)
    args = ap.parse_args(argv)

    root = Path(args.root).expanduser().resolve()
    if not root.is_dir():
        print(f"error: not a directory: {root}", file=sys.stderr)
        return 2

    report = audit(root, args.max_files)
    print(json.dumps(report, ensure_ascii=False, indent=2)
          if args.json else render(report))
    return 0


if __name__ == "__main__":
    sys.exit(main())

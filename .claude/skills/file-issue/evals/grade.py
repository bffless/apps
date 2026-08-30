#!/usr/bin/env python3
"""Scripted checks for a bffless/apps issue draft. Usage: grade.py <draft.md> [--json]

Draft format: line 1 `# <app>: <title>`, blank line, body. The checks encode what
apps-triage (.claude/agents/apps-triage.md, Steps 2-3) bounces an issue for. Judgement
calls (zero open questions, precedent, one unit of work) live in rubric.md.

Calibrated on references/examples/ (numbers in MEMORY.md): every check a bounced
issue (#460, #463) fails names the reason triage gave; the passes (#469, #471, #472,
#421) fail only the sha-line / live-note / Verify nudges this skill adds on top of
what triage already accepted. #473 fails the citation checks — it bounced once.
"""
import json, os, re, subprocess, sys

path = [a for a in sys.argv[1:] if not a.startswith('--')][0]
raw = open(path).read()
lines = raw.split('\n')
title = lines[0][2:].strip() if lines and lines[0].startswith('# ') else ''
body = '\n'.join(lines[1:]).strip()

# scopes derived from origin/main, falling back to today's list if git is unavailable
def scopes():
    try:
        root = subprocess.run(['git', 'rev-parse', '--show-toplevel'], capture_output=True, text=True, cwd=os.path.dirname(os.path.abspath(path))).stdout.strip()
        out = []
        for d in ('apps/', 'packages/'):
            out += subprocess.run(['git', '-C', root, 'ls-tree', '--name-only', 'origin/main', d], capture_output=True, text=True).stdout.split()
        names = [o.split('/', 1)[1] for o in out if '/' in o]
        if names:
            return names
    except Exception:
        pass
    return ['studio', 'handoff', 'reader', 'recall', 'workflow', 'workflow-studio', 'workflow-lint', 'workflow-headless', 'workflow-script']
SCOPES = scopes()

def no_code(s):
    s = re.sub(r'```.*?```', '', s, flags=re.S)
    return re.sub(r'`[^`\n]*`', '', s)
prose = no_code(body)
prefix = re.match(r'^([a-z0-9-]+):', title)
app = prefix.group(1) if prefix else ''
parent = re.search(r'\b(Refiled|Split) from #(\d+)', body)
boxes_open = re.findall(r'^\s*- \[ \]', body, re.M)
boxes_done = re.findall(r'^\s*- \[x\]', body, re.M | re.I)
cites = re.findall(r'[A-Za-z0-9_./-]+\.[A-Za-z0-9]+:\d+', body)
paths = re.findall(r'(?<![\w:/])(?:[A-Za-z0-9_.-]+/)+[A-Za-z0-9_.-]+\.[a-z]{1,5}\b', body)
fix_section = re.search(r'(?im)^##\s*Suggested fix', body) and re.search(r'(?m)^\s*\d+\.\s', body)
head = title + '\n' + prose.split('\n\n')[0]
touches_live = re.search(r'(?i)(proxy-rules|rule\.ya?ml|\.fn\.js|\$schema|schema\.ya?ml|\bpackages/)', body)
questions = [l for l in prose.split('\n') if l.rstrip().endswith('?')]
fork = re.findall(r'(?i)\b(should we|either\b.{0,60}\bor\b|pick one|open (question|decision)|\bTBD\b|\bTODO\b)', prose)
verify = re.search(r'(?im)^\s*(\*\*)?Verify(\*\*)?:.*$', body)
verify_txt = verify.group(0) if verify else ''
sha = re.search(r'origin/main[^\n]{0,40}\b[0-9a-f]{7,40}\b', body) or re.search(r'\b[0-9a-f]{7,40}\b[^\n]{0,40}origin/main', body)
blocked = re.findall(r'(?i)\b(blocked on|needs|requires|after|once)\b[\s*]*(bffless/)?ce[#\s]', head)
live = re.search(r'(?i)(on merge|on PR|goes? live|live (rule|surface|set|schema)|no (proxy-)?rule|rule set|rules? (are|go|land)|\$schema|no rule or schema)', body)
selfcert = re.findall(r'(?i)ready-for-agent|needs-triage|ready-for-human|apps-implement|@claude', body)

checks = [
    ("line 1 is `# <title>`", bool(title), lines[0][:60] if lines else ''),
    ("title prefix is one app/package that exists on origin/main", app in SCOPES, f"prefix={app!r}; known={SCOPES}"),
    ("title says one thing (no ' and ', <=140 chars, no trailing period)", bool(title) and ' and ' not in title and len(title) <= 140 and not title.endswith('.'), f"{len(title)} chars"),
    ("refile names its parent #N in the title", (not parent) or f"#{parent.group(2)}" in title, f"body says '{parent.group(0)}' but title lacks #{parent.group(2)}" if parent else ''),
    ("points at the code: at least one file path", len(paths) >= 1, "no path with a directory and extension"),
    ("at least one `path:line` citation", len(cites) >= 1, f"{len(cites)} found"),
    ("names the origin/main sha the citations are against", bool(sha), ''),
    ("1-3 unchecked checkboxes, or a numbered `## Suggested fix` (one unit of work)", (1 <= len(boxes_open) <= 3) or (not boxes_open and bool(fix_section)), f"{len(boxes_open)} open boxes"),
    ("no already-checked boxes (a done item belongs to the parent)", not boxes_done, f"{len(boxes_done)} [x]"),
    ("a test is named", bool(re.search(r'(?i)\btest', body)), ''),
    ("has a Verify: line", bool(verify), ''),
    ("verify chain ends in build (or stage+typecheck)", bool(re.search(rf'pnpm {re.escape(app)}:build', verify_txt)) or (':stage' in verify_txt and ':typecheck' in verify_txt) or ('build' in verify_txt), verify_txt[:80]),
    ("no questions to the reader (lines ending in ?)", not questions, ' | '.join(q.strip()[:60] for q in questions[:3])),
    ("no open fork phrasing (should we / either-or / TBD); a deliberate **Open decision:** is the one FAIL allowed here, and means ready-for-human", not fork, ', '.join(f[0] if isinstance(f, tuple) else f for f in fork[:3])),
    ("title/opening paragraph don't declare a CE / other-repo block", not blocked, ', '.join(' '.join(b).strip() for b in blocked[:3])),
    ("if rules/schemas/packages are named, says what goes live and when", (not touches_live) or bool(live), f"mentions {touches_live.group(0)!r} but no live-surface note" if touches_live else ''),
    ("no self-certification or agent-addressed text", not selfcert, ', '.join(selfcert[:3])),
    ("body length 250-6000 chars", 250 <= len(body) <= 6000, f"{len(body)} chars"),
]

if '--json' in sys.argv:
    exp = [{"text": n, "passed": bool(ok), "evidence": ev or n} for n, ok, ev in checks]
    k = sum(e['passed'] for e in exp)
    print(json.dumps({"expectations": exp, "summary": {"passed": k, "failed": len(exp) - k,
                      "total": len(exp), "pass_rate": k / len(exp)}}, indent=1))
else:
    for n, ok, ev in checks:
        print(('PASS' if ok else 'FAIL'), n, ('  [' + ev + ']') if ev and not ok else '')
    print(f"\n{sum(ok for _, ok, _ in checks)}/{len(checks)} passed")

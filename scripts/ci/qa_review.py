#!/usr/bin/env python3
"""Static pre-merge QA against the rules in CLAUDE.md / GEMINI.md.

    python3 scripts/ci/qa_review.py <base> <head> [--report out.md]

Exit 1 when any check FAILs (the PR must not merge), 0 otherwise. WARNs are
reported but never block. Runs offline in a couple of seconds, no secrets.

Checks, each scoped to what the PR changes:

  jwt            Every function in NO_VERIFY_JWT (scripts/deploy-functions.sh)
                 stays there, and no added deploy command drops --no-verify-jwt
                 for one. A deploy without the flag turns the gateway JWT check
                 back on and 401s Telegram, Woo, Resend and Clerk callers.
  pin            @supabase/supabase-js is imported at exactly 2.116.0 in the
                 bundle of every affected function (edge_affected.py). An
                 unpinned @2 broke every deploy on 2026-09-22.
  filterByUser   Added useSupabaseData() calls on shared org tables pass
                 { filterByUser: false }. The default is TRUE, so a bare call on
                 a shared table hides every other user's rows.
  secrets        No credential literal, no credential logged, no literal
                 credential in a URL query string, on any added line.
  prompt         Added prompt text: no hard-coded "must show ONLY <subject>"
                 override inside a retry/fallback path (the stripConflictingTerms
                 bug, which forced an espresso machine into bag renders), and no
                 hunk that both forbids and requires the same subject.

Only ADDED lines are judged for filterByUser / secrets / prompt, so a PR is
never blocked by debt it didn't write. pin and jwt look at the whole affected
bundle / list because that is what actually ships on deploy.

A line can opt out of a single check with a trailing comment naming it and a
reason, e.g.  `// qa-allow: secrets — public anon key, documented in README`.
"""
import os
import re
import subprocess
import sys

ROOT = subprocess.check_output(["git", "rev-parse", "--show-toplevel"], text=True).strip()
# edge_affected.py is taken from THIS script's directory: CI runs main's copy of
# both from a temp dir, so a PR cannot change which bundles get checked.
HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
sys.dont_write_bytecode = True   # importing edge_affected must not leave __pycache__/ in the repo

SUPABASE_JS_PIN = "2.116.0"
DEPLOY_SCRIPT = "scripts/deploy-functions.sh"
# Per-user tables (CLAUDE.md "filterByUser rules"). Everything else is org-wide.
PER_USER_TABLES = {"cost_settings"}
SKIP_FILES = re.compile(r"(^|/)(package-lock\.json|deno\.lock|yarn\.lock|.*\.min\.js)$|(^|/)fixtures/|\.(png|jpe?g|gif|webp|ico|pdf|mp4|woff2?|ttf)$")
MARKER = "<!-- qa-review -->"
# The checker and its self-test quote every bad pattern on purpose.
CHECKER_FILES = {"scripts/ci/qa_review.py", "scripts/ci/qa_review_test.sh"}
COMMENT_LINE = re.compile(r"^\s*(//|/\*|\*|#)")


def git(*args):
    return subprocess.check_output(["git", *args], cwd=ROOT, text=True, errors="replace")


def show(rev, path):
    try:
        return git("show", f"{rev}:{path}")
    except subprocess.CalledProcessError:
        return None


class Report:
    def __init__(self):
        self.items = []   # (level, check, location, message)
        self.notes = []   # informational lines per check

    def add(self, level, check, loc, msg):
        self.items.append((level, check, loc, msg))

    def fails(self):
        return [i for i in self.items if i[0] == "FAIL"]


def allowed(line, check):
    m = re.search(r"qa-allow:\s*([\w, -]+)", line)
    return bool(m and check in [c.strip() for c in re.split(r"[,\s—-]+", m.group(1))])


# ── diff parsing ─────────────────────────────────────────────────────────────

def added_hunks(base, head):
    """{path: [[(lineno, text), ...], ...]} — added lines grouped by hunk."""
    mb = git("merge-base", base, head).strip()
    out = git("diff", "--unified=0", "--no-color", "--no-ext-diff", f"{mb}..{head}")
    files, path, hunk, ln = {}, None, None, 0
    for raw in out.splitlines():
        if raw.startswith("+++ "):
            path = raw[6:] if raw.startswith("+++ b/") else None
            continue
        if raw.startswith("@@"):
            m = re.match(r"@@ -\S+ \+(\d+)", raw)
            ln = int(m.group(1)) if m else 0
            if path and not SKIP_FILES.search(path) and path not in CHECKER_FILES:
                hunk = []
                files.setdefault(path, []).append(hunk)
            else:
                hunk = None
            continue
        if raw.startswith("+") and not raw.startswith("+++"):
            if hunk is not None:
                hunk.append((ln, raw[1:]))
            ln += 1
    return {p: [h for h in hs if h] for p, hs in files.items() if any(hs)}


# ── jwt ──────────────────────────────────────────────────────────────────────

def no_verify_list(src):
    if not src:
        return set()
    m = re.search(r'^NO_VERIFY_JWT="([^"]*)"', src, re.M | re.S)
    return set(m.group(1).replace("\\\n", " ").split()) if m else set()


def check_jwt(rep, base, head, affected, hunks):
    before = no_verify_list(show(base, DEPLOY_SCRIPT))
    after = no_verify_list(show(head, DEPLOY_SCRIPT))
    if before and not after:
        rep.add("FAIL", "jwt", DEPLOY_SCRIPT, "NO_VERIFY_JWT could not be parsed at head — the deploy guard list is gone or reshaped.")
        return
    for fn in sorted(before - after):
        rep.add("FAIL", "jwt", DEPLOY_SCRIPT,
                f"`{fn}` was removed from NO_VERIFY_JWT. Its next deploy would turn the gateway JWT check on and 401 its callers. "
                f"If that is intended, change prod's verify_jwt first and say so in the PR.")
    for path, hs in hunks.items():
        for h in hs:
            for ln, text in h:
                m = re.search(r"functions\s+deploy\s+([\w-]+)", text)
                if m and m.group(1) in after and "--no-verify-jwt" not in text and not allowed(text, "jwt"):
                    rep.add("FAIL", "jwt", f"{path}:{ln}", f"`supabase functions deploy {m.group(1)}` without `--no-verify-jwt` (it is in NO_VERIFY_JWT).")
                if re.search(r"verify_jwt\s*=\s*true", text) and not allowed(text, "jwt"):
                    rep.add("WARN", "jwt", f"{path}:{ln}", "`verify_jwt = true` added — make sure the function is not in NO_VERIFY_JWT.")
    touched = sorted(f for f in affected if f in after)
    if touched:
        rep.notes.append(f"jwt: affected functions in NO_VERIFY_JWT, still listed: {', '.join(touched)}")


# ── pin ──────────────────────────────────────────────────────────────────────

SUPA_IMPORT = re.compile(r"""['"]((?:https://esm\.sh/|npm:|jsr:|https://cdn\.jsdelivr\.net/npm/)@supabase/supabase-js(?:@([^'"/?]*))?[^'"]*)['"]""")


def check_pin(rep, affected, hunks):
    import edge_affected  # noqa: E402 — same bundle walk the deploy uses
    files = set()
    for fn in affected:
        files |= edge_affected.bundle(os.path.join(edge_affected.FUNCS, fn, "index.ts"))
    for path in hunks:
        if path.startswith("supabase/functions/") and path.endswith(".ts"):
            files.add(os.path.join(ROOT, path))
    for f in sorted(files):
        try:
            lines = open(f, encoding="utf-8", errors="replace").read().splitlines()
        except OSError:
            continue
        for i, text in enumerate(lines, 1):
            for m in SUPA_IMPORT.finditer(text):
                if m.group(2) != SUPABASE_JS_PIN and not allowed(text, "pin"):
                    rel = os.path.relpath(f, ROOT)
                    rep.add("FAIL", "pin", f"{rel}:{i}",
                            f"`{m.group(1)}` — pin @supabase/supabase-js to exactly @{SUPABASE_JS_PIN} (an unpinned @2 broke every deploy on 2026-09-22).")
    rep.notes.append(f"pin: scanned {len(files)} file(s) across {len(affected)} affected function bundle(s)")


# ── filterByUser ─────────────────────────────────────────────────────────────

CALL = re.compile(r"useSupabaseData\(\s*['\"](\w+)['\"]\s*(?:,\s*(\{[^)]*\}))?\s*\)", re.S)


def check_filter_by_user(rep, head, hunks):
    for path, hs in hunks.items():
        if not re.search(r"\.(jsx?|tsx?)$", path) or "/supabase/functions/" in f"/{path}" or path.endswith(("hooks.js", ".test.js")):
            continue
        added = {ln for h in hs for ln, _ in h}
        src = show(head, path) or ""
        line_starts = [0]
        for i, ch in enumerate(src):
            if ch == "\n":
                line_starts.append(i + 1)
        for m in CALL.finditer(src):
            ln = next(i for i in range(len(line_starts), 0, -1) if line_starts[i - 1] <= m.start())
            if ln not in added:
                continue
            line_text = src.splitlines()[ln - 1]
            if allowed(line_text, "filterByUser"):
                continue
            table, opts = m.group(1), m.group(2) or ""
            explicit_false = re.search(r"filterByUser\s*:\s*false", opts)
            if table not in PER_USER_TABLES and not explicit_false:
                rep.add("FAIL", "filterByUser", f"{path}:{ln}",
                        f"`useSupabaseData('{table}')` on a shared org table without `{{ filterByUser: false }}` — the default (true) "
                        f"filters by user_id and hides every other team member's rows.")
            elif table in PER_USER_TABLES and explicit_false:
                rep.add("WARN", "filterByUser", f"{path}:{ln}", f"`{table}` is per-user but is read with filterByUser: false.")


# ── secrets ──────────────────────────────────────────────────────────────────

TOKEN_PATTERNS = [
    ("Anthropic key", r"sk-ant-[A-Za-z0-9_-]{20,}"),
    ("Stripe/Clerk secret key", r"\bsk_(?:live|test)_[A-Za-z0-9]{16,}"),
    ("Supabase access token", r"\bsbp_[a-f0-9]{30,}"),
    ("Supabase secret key", r"\bsb_secret_[A-Za-z0-9_-]{20,}"),
    ("JWT (service-role / anon key)", r"\beyJ[A-Za-z0-9_-]{15,}\.eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}"),
    ("Google API key", r"\bAIza[0-9A-Za-z_-]{35}\b"),
    ("Meta access token", r"\bEAA[A-Za-z0-9]{60,}"),
    ("GitHub token", r"\bgh[pousr]_[A-Za-z0-9]{36,}"),
    ("Slack token", r"\bxox[abprs]-[A-Za-z0-9-]{20,}"),
    ("WooCommerce key", r"\b(?:ck|cs)_[a-f0-9]{40}\b"),
    ("Telegram bot token", r"\b\d{8,10}:AA[A-Za-z0-9_-]{33}\b"),
    ("private key", r"-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----"),
]
SECRET_IDENT = r"(?:[A-Z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD|SERVICE_ROLE)[A-Z0-9_]*|apiKey|accessToken|refreshToken|serviceRole|secret|password|botToken)"
LOG_CALL = re.compile(r"\b(?:console\.(?:log|info|warn|error|debug)|log\.(?:info|warn|error|debug)|logger\.\w+)\s*\(")
INTERP_SECRET = re.compile(r"\$\{\s*(" + SECRET_IDENT + r")\s*\}|[+,]\s*(" + SECRET_IDENT + r")\s*[,)+]")
URL_CRED = re.compile(r"[?&](api_?key|apikey|access_token|token|secret|client_secret|consumer_key|consumer_secret|password|key)=([^&\s'\"`]*)", re.I)
CONST_SECRET = re.compile(r"\b(?:const|let|var)\s+(" + SECRET_IDENT + r")\s*(?::\s*\w+\s*)?=\s*['\"`]([A-Za-z0-9_\-./+=]{20,})['\"`]")


def looks_random(val):
    """A credential, not a name: `_minuto_faq_published` is a WP meta key, `a8Fk2…` is not."""
    if re.fullmatch(r"[a-z_]+|[A-Z_]+|[a-z][a-z0-9]*(?:[-_.][a-z0-9]+)*", val):
        return False
    return sum(c.isdigit() for c in val) >= 3 and len(set(val)) >= 12


def check_secrets(rep, hunks):
    for path, hs in hunks.items():
        warned_params = set()   # one URL-param WARN per file and parameter, not one per line
        is_example = re.search(r"\.example(\.|$)|(^|/)docs/|_test\.|\.test\.", path)
        for h in hs:
            for ln, text in h:
                if allowed(text, "secrets"):
                    continue
                loc = f"{path}:{ln}"
                for label, pat in TOKEN_PATTERNS:
                    if re.search(pat, text):
                        rep.add("FAIL", "secrets", loc, f"looks like a literal {label}. Credentials live in Supabase Vault / `supabase secrets`, never in the repo.")
                if LOG_CALL.search(text):
                    m = INTERP_SECRET.search(text)
                    if m and not re.search(r"\.(length|slice|substring)\b|\?\s*['\"]|!!", text):
                        rep.add("FAIL", "secrets", loc, f"`{m.group(1) or m.group(2)}` is written to a log line — logs are durable (system_logs, 30 days) and readable by admins.")
                for m in URL_CRED.finditer(text):
                    val = m.group(2)
                    if not val or val.startswith(("${", "{", "<", "$")) or val in ("REDACTED", "xxx", "...") or is_example:
                        if val.startswith(("${", "{")) and not is_example and m.group(1).lower() not in warned_params:
                            warned_params.add(m.group(1).lower())
                            rep.add("WARN", "secrets", loc,
                                    f"`{m.group(1)}=` in a URL query string. Prefer a header; a token in a URL leaks into logs, retries and error output.")
                        continue
                    if len(val) >= 8:
                        rep.add("FAIL", "secrets", loc, f"literal `{m.group(1)}=` value in a URL.")
                m = CONST_SECRET.search(text)
                if m and not is_example and looks_random(m.group(2)):
                    rep.add("FAIL", "secrets", loc, f"`{m.group(1)}` is assigned a hard-coded literal. Read it from the environment.")


# ── prompt audit ─────────────────────────────────────────────────────────────

EXCLUSIVE = re.compile(r"\b(?:must|should|will)\s+(?:only\s+)?(?:show|depict|contain|feature|include)\s+ONLY\b|\bONLY\s+the\s+[\w -]{3,40}?(?:,|\band\b)[^.]*\bnothing else\b", re.I)
RETRYISH = re.compile(r"retry|fallback|strip|augment|regenerat|escalat|attempt|repair|rescue|simplif|conflict", re.I)
FUNC_DEF = re.compile(r"(?:function\s+(\w+)|(?:const|let)\s+(\w+)\s*=\s*(?:async\s*)?(?:\([^)]*\)|\w+)\s*=>)")
NEG = re.compile(r"\b(?:no|never|without|avoid|forbid\w*|do not (?:include|show)|don't (?:include|show))\s+(?:any\s+|a\s+|an\s+|the\s+)?([a-z]+(?:\s[a-z]+)?)", re.I)
POS = re.compile(r"\b(?:must|always)\s+(?:show|include|feature|contain|have|depict)\s+(?:a\s+|an\s+|the\s+)?([a-z]+(?:\s[a-z]+)?)", re.I)
STOP = {"text", "other", "more", "less", "image", "render", "photo", "shot", "one", "it", "this", "that", "longer", "need", "way", "matter", "only"}


def head_noun(phrase):
    w = phrase.lower().split()[-1]
    return w[:-1] if w.endswith("s") and not w.endswith("ss") else w


def enclosing_function(src_lines, ln):
    for i in range(ln - 1, max(-1, ln - 200), -1):
        m = FUNC_DEF.search(src_lines[i])
        if m:
            return m.group(1) or m.group(2)
    return None


def check_prompts(rep, head, hunks):
    for path, hs in hunks.items():
        if not (path.startswith("supabase/functions/") and path.endswith(".ts")) or re.search(r"_test\.ts$", path):
            continue
        src_lines = (show(head, path) or "").splitlines()
        for h in hs:
            negs, poss = {}, {}
            for ln, text in h:
                if allowed(text, "prompt") or COMMENT_LINE.match(text):
                    continue   # a prompt lives in a string; a comment quoting one is not a prompt
                if EXCLUSIVE.search(text):
                    fn = enclosing_function(src_lines, ln) or "?"
                    if RETRYISH.search(fn):
                        rep.add("FAIL", "prompt", f"{path}:{ln}",
                                f"hard-coded exclusive subject override inside `{fn}()` — a retry/fallback path. This is the "
                                f"stripConflictingTerms bug shape: a fixed 'ONLY the <subject>' tail fights whatever the brief asked for. "
                                f"Derive the subject from the brief instead.")
                    else:
                        rep.add("WARN", "prompt", f"{path}:{ln}", "exclusive 'ONLY …' constraint added to a prompt — make sure it is derived from the brief, not hard-coded.")
                for m in NEG.finditer(text):
                    n = head_noun(m.group(1))
                    if n not in STOP:
                        negs.setdefault(n, ln)
                for m in POS.finditer(text):
                    n = head_noun(m.group(1))
                    if n not in STOP:
                        poss.setdefault(n, ln)
            for n in sorted(set(negs) & set(poss)):
                rep.add("WARN", "prompt", f"{path}:{negs[n]}",
                        f"this hunk both forbids and requires `{n}` (lines {negs[n]} and {poss[n]}) — contradictory constraints make the model pick one at random.")


# ── output ───────────────────────────────────────────────────────────────────

def render(rep, affected):
    fails = rep.fails()
    warns = [i for i in rep.items if i[0] == "WARN"]
    head = "❌ **QA review: blocking issues found**" if fails else ("⚠️ **QA review: passed with warnings**" if warns else "✅ **QA review: all checks passed**")
    out = [MARKER, head, ""]
    out.append(f"Affected edge functions: {', '.join(f'`{f}`' for f in affected) or '_none_'}")
    out.append("")
    if rep.items:
        out += ["| | Check | Where | Detail |", "|---|---|---|---|"]
        for level, check, loc, msg in sorted(rep.items, key=lambda i: (i[0] != "FAIL", i[1], i[2])):
            icon, cell = ("❌" if level == "FAIL" else "⚠️"), msg.replace("|", "\\|")
            out.append(f"| {icon} | {check} | `{loc}` | {cell} |")
        out.append("")
    checks = ["jwt", "pin", "filterByUser", "secrets", "prompt"]
    status = []
    for c in checks:
        lv = {i[0] for i in rep.items if i[1] == c}
        status.append(f"{'❌' if 'FAIL' in lv else '⚠️' if 'WARN' in lv else '✅'} {c}")
    out.append(" · ".join(status))
    if rep.notes:
        out += ["", "<details><summary>details</summary>", ""] + [f"- {n}" for n in rep.notes] + ["", "</details>"]
    out += ["", "<sub>scripts/ci/qa_review.py · rules from CLAUDE.md / GEMINI.md · a line can opt out with `qa-allow: <check> — reason`</sub>"]
    return "\n".join(out)


def main():
    args = [a for a in sys.argv[1:] if not a.startswith("--report")]
    report_path = None
    if "--report" in sys.argv:
        report_path = sys.argv[sys.argv.index("--report") + 1]
        args = [a for a in args if a != report_path]
    if len(args) != 2:
        sys.exit("usage: qa_review.py <base> <head> [--report out.md]")
    base, head = args
    mb = git("merge-base", base, head).strip()
    affected = subprocess.check_output([sys.executable, os.path.join(HERE, "edge_affected.py"), mb, head], cwd=ROOT, text=True).split()
    hunks = added_hunks(base, head)

    rep = Report()
    check_jwt(rep, mb, head, affected, hunks)
    check_pin(rep, affected, hunks)
    check_filter_by_user(rep, head, hunks)
    check_secrets(rep, hunks)
    check_prompts(rep, head, hunks)

    md = render(rep, affected)
    if report_path:
        with open(report_path, "w", encoding="utf-8") as fh:
            fh.write(md + "\n")
    print(md)
    sys.exit(1 if rep.fails() else 0)


if __name__ == "__main__":
    main()

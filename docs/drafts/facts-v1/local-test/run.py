"""Apply the facts-v1 set to a THROWAWAY local Postgres in apply order, twice (idempotency), on
top of a baseline that mirrors live: 045's function + view (074 with its fact edits stripped) and
the live user_active_tracks_with_reason. Then run tests.sql. Never point this at Supabase.

Files are looked up in migrations/ first (applied), then docs/drafts/facts-v1/ (still draft).

Setup once (any empty data dir; trust auth is fine for a local throwaway):
  initdb -D <dir> -U postgres -A trust -E UTF8 --locale=C
  pg_ctl -D <dir> -o "-p 55432" -l <dir>/log -w start
Run:   python run.py        (env PSQL overrides the psql path, PGPORT the port)
Stop:  pg_ctl -D <dir> stop
"""
import io, os, re, subprocess, sys, tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
DRAFTS = os.path.dirname(HERE)
MIGRATIONS = os.path.abspath(os.path.join(DRAFTS, "..", "..", "..", "migrations"))
PSQL = os.environ.get("PSQL", r"C:/Program Files/PostgreSQL/17/bin/psql.exe")
DB = "facts_test"
BASE = [PSQL, "-h", "localhost", "-p", os.environ.get("PGPORT", "55432"), "-U", "postgres",
        "-v", "ON_ERROR_STOP=1", "-X"]
ORDER = ["069_fact_vocabulary.sql", "070_user_facts.sql", "071_user_facts_latest.sql",
         "072_fact_track_rules.sql", "073_fact_entry_map.sql",
         "076_user_facts_user_id_fk.sql",          # applied before 074 (D1)
         "074_user_active_tracks_facts_arm.sql", "075_seed_demo_vocabulary.sql",
         "077_user_external_ids.OPTIONAL.sql"]


def find(name):
    for d in (MIGRATIONS, DRAFTS):
        p = os.path.join(d, name)
        if os.path.exists(p):
            return p
    raise FileNotFoundError(name)


def psql(args, db=DB, label=""):
    r = subprocess.run(BASE + ["-d", db] + args, capture_output=True, text=True, encoding="utf-8")
    out = (r.stdout + r.stderr).strip()
    if r.returncode != 0:
        print(f"!! {label} FAILED\n{out}")
        sys.exit(1)
    return out


def build_045_baseline():
    """074's sections 1 (function) and 2 (view) with the fact edits stripped = migration 045."""
    src = io.open(find("074_user_active_tracks_facts_arm.sql"), encoding="utf-8").read()
    fn = src[src.index("-- ---- 1. Per-user function"): src.index("COMMENT ON FUNCTION user_active_tracks_for_user")]
    vw = src[src.index("-- ---- 2. The view twin"): src.index("-- ---- 3. user_active_tracks_with_reason")]
    body = fn + vw
    # drop the fact_tracks CTE (from its opening line up to the next CTE)
    body, n1 = re.subn(r"  \), fact_tracks AS \([^\n]*\n(?:(?!  \), base_set AS).*\n)*", "", body)
    # drop "UNION\n    SELECT fact_tracks..." inside base_set
    body, n2 = re.subn(r"\n    UNION\n    SELECT fact_tracks[^\n]*", "", body)
    assert n1 == 2 and n2 == 2, (n1, n2)
    for gone in ("fact_tracks", "user_facts_latest", "user_fact_track_ids", "fact_track_rules"):
        assert gone not in body, gone
    path = os.path.join(tempfile.gettempdir(), "facts_v1_baseline_045.sql")  # generated; keep out of the repo
    io.open(path, "w", encoding="utf-8").write("BEGIN;\n" + body + "\nCOMMIT;\n")
    return path


subprocess.run(BASE + ["-d", "postgres", "-c", f"DROP DATABASE IF EXISTS {DB}"], capture_output=True)
psql(["-c", f"CREATE DATABASE {DB}"], db="postgres", label="createdb")
psql(["-f", os.path.join(HERE, "stubs.sql")], label="stubs")
psql(["-f", build_045_baseline()], label="045 baseline")
psql(["-f", os.path.join(HERE, "with_reason_live.sql")], label="with_reason live baseline")
print("stubs + 045 baseline + live with_reason loaded")

# 074 PRE-CHECK 2 against the baseline, and the snapshots for the no-op proofs
fn = psql(["-Atc", "SELECT pg_get_functiondef('user_active_tracks_for_user(uuid)'::regprocedure)"])
vw = psql(["-Atc", "SELECT pg_get_viewdef('user_active_tracks'::regclass, true)"])
assert "archived_at IS NULL" in fn and "archived_at IS NULL" in vw and "fact_tracks" not in fn + vw
psql(["-c", "CREATE TABLE _snap_045 AS SELECT user_id, track_id FROM user_active_tracks"])
psql(["-c", "CREATE TABLE _snap_reason AS SELECT * FROM user_active_tracks_with_reason"])
print("074 pre-check 2 OK on baseline; snapshot rows:", psql(["-Atc", "SELECT count(*) FROM _snap_045"]))
print("baseline md5 fn/view/with_reason:", psql(["-Atc",
      "SELECT md5(pg_get_functiondef('user_active_tracks_for_user(uuid)'::regprocedure)) || ' ' || "
      "md5(pg_get_viewdef('user_active_tracks'::regclass, true)) || ' ' || "
      "md5(pg_get_viewdef('user_active_tracks_with_reason'::regclass, true))"]),
      "(live: 796581909515a353c5a8ac20a3e30597 79bf5b049601d4f246072b6e434122a4 8393d8efcc135d42d2ece9011797620f)")

for rnd in (1, 2):
    for f in ORDER:
        psql(["-q", "-f", find(f)], label=f"round {rnd} {f}")
    print(f"round {rnd}: all 8 files applied cleanly")

out = psql(["-q", "-f", os.path.join(HERE, "tests.sql")], label="tests")
print("\n".join(re.sub(r"^psql:[^ ]+ NOTICE:\s+", "", l) for l in out.splitlines()))

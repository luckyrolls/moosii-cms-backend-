"""Apply the facts-v1 drafts to a THROWAWAY local Postgres in README order, twice (idempotency),
after building a 045 baseline for 074 to replace. Then run tests.sql. Never point this at Supabase.

Setup once (any empty data dir; trust auth is fine for a local throwaway):
  initdb -D <dir> -U postgres -A trust -E UTF8 --locale=C
  pg_ctl -D <dir> -o "-p 55432" -l <dir>/log -w start
Run:   python run.py        (env PSQL overrides the psql path, PGPORT the port)
Stop:  pg_ctl -D <dir> stop
"""
import io, os, re, subprocess, sys, tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
DRAFTS = os.path.dirname(HERE)
PSQL = os.environ.get("PSQL", r"C:/Program Files/PostgreSQL/17/bin/psql.exe")
DB = "facts_test"
BASE = [PSQL, "-h", "localhost", "-p", os.environ.get("PGPORT", "55432"), "-U", "postgres",
        "-v", "ON_ERROR_STOP=1", "-X"]
ORDER = ["069_fact_vocabulary.sql", "070_user_facts.sql", "071_user_facts_latest.sql",
         "072_fact_track_rules.sql", "073_fact_entry_map.sql",
         "074_user_active_tracks_facts_arm.sql", "075_seed_demo_vocabulary.sql",
         "076_user_external_ids.OPTIONAL.sql"]


def psql(args, db=DB, label=""):
    r = subprocess.run(BASE + ["-d", db] + args, capture_output=True, text=True, encoding="utf-8")
    out = (r.stdout + r.stderr).strip()
    if r.returncode != 0:
        print(f"!! {label} FAILED\n{out}")
        sys.exit(1)
    return out


def build_045_baseline():
    """074 with its two ADDED (074) edits removed = migration 045's pair."""
    src = io.open(os.path.join(DRAFTS, ORDER[5]), encoding="utf-8").read()
    body = src[src.index("BEGIN;"): src.index("COMMIT;") + len("COMMIT;")]
    # drop the fact_tracks CTE (from its opening line up to the next CTE)
    body, n1 = re.subn(r"  \), fact_tracks AS \([^\n]*\n(?:(?!  \), base_set AS).*\n)*", "", body)
    # drop "UNION\n    SELECT fact_tracks..." inside base_set
    body, n2 = re.subn(r"\n    UNION\n    SELECT fact_tracks[^\n]*", "", body)
    body = body.replace("Migration 074 added the fact_tracks arm (user_facts_latest x fact_track_rules).", "")
    assert n1 == 2 and n2 == 2, (n1, n2)
    assert "fact_tracks" not in body and "user_facts_latest" not in body
    path = os.path.join(tempfile.gettempdir(), "facts_v1_baseline_045.sql")  # generated; keep out of the repo
    io.open(path, "w", encoding="utf-8").write(body)
    return path


subprocess.run(BASE + ["-d", "postgres", "-c", f"DROP DATABASE IF EXISTS {DB}"], capture_output=True)
psql(["-c", f"CREATE DATABASE {DB}"], db="postgres", label="createdb")
psql(["-f", os.path.join(HERE, "stubs.sql")], label="stubs")
psql(["-f", build_045_baseline()], label="045 baseline")
print("stubs + 045 baseline loaded")

# 074 PRE-CHECK 2/3 against the baseline, and the snapshot for the no-op proof
fn = psql(["-Atc", "SELECT pg_get_functiondef('user_active_tracks_for_user(uuid)'::regprocedure)"])
vw = psql(["-Atc", "SELECT pg_get_viewdef('user_active_tracks'::regclass, true)"])
assert "archived_at IS NULL" in fn and "archived_at IS NULL" in vw and "fact_tracks" not in fn + vw
psql(["-c", "CREATE TABLE _snap_045 AS SELECT user_id, track_id FROM user_active_tracks"])
print("074 pre-check 2 OK on baseline; snapshot rows:", psql(["-Atc", "SELECT count(*) FROM _snap_045"]))
print("baseline md5 fn/view:", psql(["-Atc",
      "SELECT md5(pg_get_functiondef('user_active_tracks_for_user(uuid)'::regprocedure)) || ' ' || "
      "md5(pg_get_viewdef('user_active_tracks'::regclass, true))"]))

for rnd in (1, 2):
    for f in ORDER:
        psql(["-q", "-f", os.path.join(DRAFTS, f)], label=f"round {rnd} {f}")
    print(f"round {rnd}: all 8 files applied cleanly")

out = psql(["-q", "-f", os.path.join(HERE, "tests.sql")], label="tests")
print("\n".join(re.sub(r"^psql:[^ ]+ NOTICE:\s+", "", l) for l in out.splitlines()))

import io, sys, re, json
path = sys.argv[1]
lines = io.open(path, encoding="utf-8", errors="replace").read().split("\n")
phases = {}        # phase -> {metric: value}
cur = None
jsonblob = []
in_json = False
for ln in lines:
    if ln.startswith("returned|"):
        in_json = True; jsonblob.append(ln.split("|", 1)[1]); continue
    if in_json:
        jsonblob.append(ln)
        if ln == "}":
            in_json = False
        continue
    if "|" not in ln: continue
    k, v = ln.split("|", 1)
    if k == "phase":
        cur = v; phases.setdefault(cur, {}); continue
    if cur: phases[cur][k] = v

ret = json.loads("\n".join(jsonblob))
order = ["before_ro", "in_txn_before", "in_txn_after", "after_rollback_ro"]
keys = list(phases[order[0]].keys())

print("== returned.deleted (non-zero / non-numeric only) ==")
for k, v in sorted(ret["deleted"].items()):
    if v != 0: print(f"  {k} = {v}")
print(f"  depth={ret['depth']} found={ret['found']}")

print("\n== metrics that CHANGED inside the transaction ==")
changed = []
for k in keys:
    a, b = phases["in_txn_before"].get(k), phases["in_txn_after"].get(k)
    if a != b: changed.append((k, a, b)); print(f"  {k}: {a} -> {b}")
if not changed: print("  (none)")

print("\n== ROLLBACK proof: before_ro vs after_rollback_ro ==")
drift = [(k, phases['before_ro'].get(k), phases['after_rollback_ro'].get(k))
         for k in keys if phases['before_ro'].get(k) != phases['after_rollback_ro'].get(k)]
if drift:
    for k, a, b in drift: print(f"  !! DRIFT {k}: {a} -> {b}")
else:
    print(f"  IDENTICAL on all {len(keys)} metrics -- nothing persisted")

print("\n== never-touched columns, checked INSIDE the transaction ==")
deny = ["role","can_publish","can_review_editorial","can_approve_clinical","is_test_account",
        "has_email","is_verified","auth_provider","daily_reminder_time","user_offset","has_fcm",
        "created_at","allow_daily","likes_push","facts_seed","audit_rows"]
for k in deny:
    a, b = phases["in_txn_before"].get(k), phases["in_txn_after"].get(k)
    mark = "OK  " if a == b else "CHANGED"
    note = "" if a == b else f"  <-- {a} -> {b}"
    print(f"  {mark} {k} = {a}{note}")

print("\n== reset-target user columns, INSIDE the transaction ==")
for k in ["moosies","onb","mlp_intro","lesson_intro","quest_intro","birth_date","name_is_default",
          "display_name","gender","birth_month","birth_year","parenting_status","financials",
          "image_url","image_blur_hash","phone","region"]:
    a, b = phases["in_txn_before"].get(k), phases["in_txn_after"].get(k)
    print(f"  {k}: {a!r} -> {b!r}")

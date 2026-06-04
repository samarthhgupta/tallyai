import os, json, sys, urllib.request, urllib.error
from pathlib import Path

TOKEN = os.environ["SUPABASE_ACCESS_TOKEN"]
URL = "https://api.supabase.com/v1/projects/idstdsuvxqzoankkfgde/database/query"

def run_sql(sql):
    data = json.dumps({"query": sql}).encode("utf-8")
    req = urllib.request.Request(URL, data=data, method="POST")
    req.add_header("Authorization", "Bearer " + TOKEN)
    req.add_header("Content-Type", "application/json")
    req.add_header("User-Agent", "TallyAI-Migrations/1.0")
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            return 200, r.read().decode("utf-8")
    except urllib.error.HTTPError as e:
        body = e.read().decode("utf-8")
        print(f"    HTTP {e.code}: {body[:500]}")
        return e.code, body
    except Exception as e:
        print(f"    Exception ({type(e).__name__}): {e}")
        return -1, str(e)

print("Step 1: Creating tracking table...")
code, body = run_sql(
    "CREATE TABLE IF NOT EXISTS _migrations "
    "(name TEXT PRIMARY KEY, applied_at TIMESTAMPTZ DEFAULT NOW());"
)
if code != 200:
    print(f"FATAL (HTTP {code}): {body[:500]}")
    sys.exit(1)
print("  OK")

print("Step 2: Fetching applied migrations...")
code, body = run_sql("SELECT name FROM _migrations ORDER BY name;")
if code != 200:
    print(f"FATAL (HTTP {code}): {body[:500]}")
    sys.exit(1)
applied = {row["name"] for row in json.loads(body)}
print(f"  Already applied: {sorted(applied)}")

print("Step 3: Running pending migrations...")
failed = False
for f in sorted(Path("supabase/migrations").glob("*.sql")):
    if f.name in applied:
        print(f"  skip  {f.name}")
        continue
    print(f"  run   {f.name} ...", flush=True)
    sql = f.read_text(encoding="utf-8")
    code, body = run_sql(sql)
    if code != 200:
        print(f"  FAIL  {f.name}")
        failed = True
        break
    name_safe = f.name.replace("'", "''")
    code2, body2 = run_sql(
        f"INSERT INTO _migrations (name) VALUES ('{name_safe}') ON CONFLICT DO NOTHING;"
    )
    if code2 != 200:
        print(f"  FAIL  recording {f.name}: {body2[:200]}")
        failed = True
        break
    print(f"  done  {f.name}")

if failed:
    sys.exit(1)
print("All migrations applied successfully.")

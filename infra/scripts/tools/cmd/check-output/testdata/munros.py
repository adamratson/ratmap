import json, sys

EXPECTED_MUNROS = 282

count = 0
with open(sys.argv[1]) as f:
    for line in f:
        line = line.lstrip("\x1e").strip()
        if not line:
            continue
        lists = json.loads(line).get("properties", {}).get("lists", "")
        if "munro" in lists.split(";"):
            count += 1

if count == 0:
    print("  (no munro=yes nodes in this extract — count assertion skipped)")
elif count != EXPECTED_MUNROS:
    sys.exit(f"FAIL: {count} munros, expected {EXPECTED_MUNROS}")
else:
    print(f"  OK {count} munros")
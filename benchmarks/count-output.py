# Prices the response side written by output-cost.mjs, with the same encoder
# count.py uses. Reads the raw bodies, prints only aggregates: the bodies are
# live workspace content and must not end up in the repo or in a report.
import json, sys, statistics, tiktoken

enc = tiktoken.get_encoding("o200k_base")
path = sys.argv[1] if len(sys.argv) > 1 else "output-cost.json"
doc = json.load(open(path))
rows = doc["rows"]

for r in rows:
    r["a"] = len(enc.encode(r["ours"]["text"]))
    r["b"] = len(enc.encode(r["official"]["text"]))

bad = [r for r in rows if not r["ours"]["ok"] or not r["official"]["ok"]]
if bad:
    print(f"!! {len(bad)} pair(s) had an error response and are excluded:")
    for r in bad:
        print(f"   {r['task']} / {r['target']}  ours_ok={r['ours']['ok']} official_ok={r['official']['ok']}")
    rows = [r for r in rows if r["ours"]["ok"] and r["official"]["ok"]]

tasks = {}
for r in rows:
    tasks.setdefault(r["task"], []).append(r)

print(f"\nresponse tokens, o200k_base, Notion-Version {doc['notionVersion']}, {len(rows)} matched pairs\n")
print(f"{'task':<26} {'n':>3} {'ours':>9} {'official':>9} {'delta':>8}")
print("-" * 60)
for task, rs in tasks.items():
    a, b = sum(r["a"] for r in rs), sum(r["b"] for r in rs)
    delta = f"{100*(1-a/b):+.0f}%" if b else "n/a"
    print(f"{task:<26} {len(rs):>3} {a:>9,} {b:>9,} {delta:>8}")

ta, tb = sum(r["a"] for r in rows), sum(r["b"] for r in rows)
print("-" * 60)
print(f"{'TOTAL':<26} {len(rows):>3} {ta:>9,} {tb:>9,} {100*(1-ta/tb):>+7.0f}%")

# The verbose pair is the control: same object, same shape, so it should land on
# top of the official figure. A drift here means the two servers are not reading
# the same thing and the other rows cannot be trusted.
ctrl = tasks.get("get_page (verbose)", [])
if ctrl:
    drift = [abs(r["a"] - r["b"]) for r in ctrl]
    print(f"\ncontrol — get_page(verbose) vs official, same raw shape:")
    print(f"   max drift {max(drift)} tokens across {len(ctrl)} pages (0 means identical payloads)")

per = [(r["b"] - r["a"]) for r in rows]
print(f"\nper-call saving: median {statistics.median(per):,.0f} tokens, "
      f"max {max(per):,}, min {min(per):,}")

# The fixture grades pages by size on purpose, so the interesting result is the
# curve rather than one average: a flat row is structural overhead, a rising one
# scales with content.
sizes = [r["target"] for r in rows if r["task"] == "get_page (slim)"]
if sizes:
    print("\nby page size (fixture pages, ours / official):\n")
    per_task = ["get_page (slim)", "page markdown", "block children"]
    print(f"{'page':<20} " + " ".join(f"{t:>26}" for t in per_task))
    print("-" * (20 + 27 * len(per_task)))
    for s_ in sizes:
        cells = []
        for t in per_task:
            m = [r for r in rows if r["task"] == t and r["target"] == s_]
            if m:
                a, b = m[0]["a"], m[0]["b"]
                cells.append(f"{a:>7,} /{b:>8,} ({100*(1-a/b):>+4.0f}%)")
            else:
                cells.append(" " * 26)
        print(f"{s_:<20} " + " ".join(cells))

# A session pays the static surface once and the responses every call, so the
# crossover is where the response side overtakes the thing we advertise.
STATIC_OURS, STATIC_OFFICIAL = 1005, 17163
gap = STATIC_OFFICIAL - STATIC_OURS
avg = statistics.mean(per)
print(f"\nstatic surface saves {gap:,} tokens, once per session.")
print(f"mean response saving is {avg:,.0f} tokens per call, "
      f"so the response side overtakes it after ~{gap/avg:.0f} calls.")

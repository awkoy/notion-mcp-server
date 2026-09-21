import json, tiktoken
enc = tiktoken.get_encoding("o200k_base")   # GPT-4o/4.1 tokenizer, modern proxy for LLM context

def tool_to_api_shape(t):
    # What an MCP client forwards to the model's tool-use API:
    return {"name": t.get("name",""), "description": t.get("description",""),
            "input_schema": t.get("inputSchema", {})}

def measure(path):
    d = json.load(open(path))
    tools = d["tools"]
    payload = [tool_to_api_shape(t) for t in tools]
    blob = json.dumps(payload, ensure_ascii=False, separators=(",", ":"))
    total = len(enc.encode(blob))
    per = []
    for t in payload:
        b = json.dumps(t, ensure_ascii=False, separators=(",", ":"))
        per.append((t["name"], len(enc.encode(b))))
    return d["label"], len(tools), total, len(blob), per

results = {}
for f in ["official.json", "awkoy.json"]:
    label, n, tok, chars, per = measure(f)
    results[label] = (n, tok, chars, per)
    print(f"\n=== {label} ===")
    print(f"tools: {n} | total tokens: {tok:,} | chars: {chars:,}")
    for name, pt in sorted(per, key=lambda x:-x[1])[:6]:
        print(f"   {pt:>6,}  {name}")

o = results["notion-official"]; a = results["awkoy"]
print("\n" + "="*50)
print(f"official: {o[1]:,} tokens across {o[0]} tools")
print(f"awkoy:    {a[1]:,} tokens across {a[0]} tools")
red = 100*(1 - a[1]/o[1])
print(f"reduction: {red:.1f}%  ({o[1]/a[1]:.1f}x smaller)")

# On-demand half: prices all-describe.json (written by describe-all.mjs) so the
# session profiles and the worst case in README.md can be regenerated rather
# than taken on trust. Skipped when the file isn't there.
import os
if os.path.exists("all-describe.json"):
    described = json.load(open("all-describe.json"))
    cost = {op: len(enc.encode(text)) for op, text in described.items()}
    per_op = sorted(cost.values())
    catalog = sum(per_op)
    static = results["awkoy"][1]
    baseline = results["notion-official"][1]
    top5 = sorted(cost.items(), key=lambda kv: -kv[1])[:5]

    print("\n" + "=" * 50)
    print(f"notion_describe across {len(per_op)} operations")
    print(f"   median {per_op[len(per_op)//2]:,} | mean {catalog/len(per_op):.0f} | "
          f"min {per_op[0]:,} | max {per_op[-1]:,}")
    print(f"   top 5 = {100*sum(v for _, v in top5)/catalog:.0f}% of the catalog: "
          + ", ".join(f"{k} ({v:,})" for k, v in top5))

    sessions = [
        ("Read a page", ["get_page"]),
        ("Search + read", ["search_pages", "get_page"]),
        ("Query a database", ["query_database"]),
        ("Typical mixed (4 ops)", ["get_page", "search_pages", "append_blocks", "query_database"]),
        ("Write: page + blocks", ["create_page", "append_blocks"]),
        ("Heavy (8 ops)", ["search_pages", "get_page", "query_database", "create_page",
                           "append_blocks", "set_page_properties", "update_block", "list_comments"]),
    ]
    print("\nsession totals (static + only what the task describes):")
    for name, ops in sessions:
        missing = [o for o in ops if o not in cost]
        if missing:
            print(f"   {name:24} skipped, not in catalog: {', '.join(missing)}")
            continue
        total = static + sum(cost[o] for o in ops)
        print(f"   {name:24} {total:6,}  ({100*(1-total/baseline):.0f}% less than {baseline:,})")
    worst = static + catalog
    print(f"\nworst case, describe everything: {worst:,} vs baseline {baseline:,} "
          f"({'above' if worst > baseline else 'below'})")

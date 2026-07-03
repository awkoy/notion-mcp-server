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

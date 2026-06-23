#!/usr/bin/env python3

# Source: https://gist.github.com/am17an/228edfb84ed082aa88e3865d6fa27090

import argparse, json, statistics, sys, time
from concurrent.futures import ThreadPoolExecutor
from urllib import request

PROMPTS = [
    {"name": "code_python",      "prompt": "Write a Python function that returns the n-th Fibonacci number using memoization. Include a docstring."},
    {"name": "code_cpp",         "prompt": "Write a C++ template function `clamp(x, lo, hi)` that returns x clamped to [lo, hi]. No std::clamp."},
    {"name": "explain_concept",  "prompt": "Explain how speculative decoding works in large language model inference, in three short paragraphs."},
    {"name": "summarize",        "prompt": "Summarize in two sentences: The Industrial Revolution began in Britain in the late 18th century, transforming manufacturing through mechanization, steam power, and the factory system. It spread to continental Europe and North America during the 19th century."},
    {"name": "qa_factual",       "prompt": "Q: What are the four fundamental forces of physics?\nA:"},
    {"name": "translation",      "prompt": "Translate to French: 'The quick brown fox jumps over the lazy dog.'"},
    {"name": "creative_short",   "prompt": "Write a four-line poem about an old lighthouse."},
    {"name": "stepwise_math",    "prompt": "Solve step by step: A train leaves station A at 60 km/h. Two hours later, a second train leaves the same station on the same track at 90 km/h. How long until the second train catches the first?"},
    {"name": "long_code_review", "prompt": (
        "You are reviewing a backend service that has been suffering intermittent latency spikes "
        "in production. Below is the relevant code and a description of the system. After reading "
        "carefully, produce a structured review with three sections: (1) likely root causes ranked "
        "by probability, (2) concrete code or configuration changes you would make first, "
        "(3) what telemetry you would add to confirm the diagnosis.\n\n"
        "System description: a Python FastAPI service in front of a Postgres 15 database, deployed "
        "as four replicas behind an nginx load balancer. Each request reads a user record, fetches "
        "their last 50 events from a partitioned events table, computes an aggregate score, writes "
        "the score back to the user row, and returns a JSON response. Average payload is 4 KB. "
        "p50 latency is 35 ms; p99 spikes to 1.8 seconds approximately every 90 seconds in a "
        "regular pattern. The spikes correlate with elevated Postgres CPU but not with elevated "
        "Postgres connection count. The application pool is sized at 20 connections per replica. "
        "PgBouncer is in front of Postgres in transaction pooling mode with a pool size of 50.\n\n"
        "Code excerpt — the hot endpoint:\n"
        "```python\n@app.post('/score/{user_id}')\nasync def score(user_id: int, payload: ScoreRequest):\n"
        "    async with db.transaction() as tx:\n        user = await tx.fetchrow(\n"
        "            'SELECT id, tier, last_score FROM users WHERE id = $1 FOR UPDATE',\n            user_id,\n        )\n"
        "        if user is None:\n            raise HTTPException(404)\n        events = await tx.fetch(\n"
        "            'SELECT type, weight, ts FROM events '\n            'WHERE user_id = $1 ORDER BY ts DESC LIMIT 50',\n            user_id,\n        )\n"
        "        new_score = compute_score(user['tier'], events, payload.signals)\n"
        "        await tx.execute(\n            'UPDATE users SET last_score = $1, updated_at = now() WHERE id = $2',\n            new_score, user_id,\n        )\n"
        "        await tx.execute(\n            'INSERT INTO score_history (user_id, score, ts) VALUES ($1, $2, now())',\n            user_id, new_score,\n        )\n"
        "    await cache.set(f'score:{user_id}', new_score, ex=300)\n"
        "    metrics.histogram('score.latency_ms').observe((time.time() - start) * 1000)\n"
        "    return {'user_id': user_id, 'score': new_score}\n```\n\n"
        "Schema notes: `users` is ~50M rows, `events` is partitioned by month with ~2B rows total "
        "and a btree index on `(user_id, ts DESC)`. `score_history` is unpartitioned, ~800M rows, "
        "with a single index on `user_id`. Postgres autovacuum is at default settings. There is "
        "a nightly batch job that rebuilds materialized views starting at 02:00 UTC; spikes occur "
        "throughout the day, not just during the batch window. Connection pooling metrics show "
        "PgBouncer waiting connections occasionally hit 8-12 during spikes but never saturate. "
        "CPU on the FastAPI replicas stays below 30% even during spikes. Network round-trip time "
        "between the application and Postgres is consistently 0.4 ms.\n\nBegin your review now."
    )},
]

def post(url, payload):
    req = request.Request(url, data=json.dumps(payload).encode(), headers={"Content-Type":"application/json"}, method="POST")
    with request.urlopen(req, timeout=300) as r:
        return json.loads(r.read())

def one_request(args, p):
    # Run a single prompt. Errors are captured (not raised) so one failed request
    # does not abort the whole concurrent batch.
    t0 = time.time()
    try:
        r = post(f"{args.url}/v1/chat/completions", {
            "model": args.model,
            "messages": [{"role": "user", "content": p["prompt"]}],
            "max_tokens": 192,
            "seed": 42,
        })
    except Exception as e:
        return {"name": p["name"], "wall_s": round(time.time()-t0,3), "predicted_n": 0,
                "predicted_per_second": 0.0, "draft_n": 0, "draft_n_accepted": 0,
                "accept_rate": None, "error": str(e)}
    wall = time.time() - t0
    # OpenAI-compatible endpoint: timings are in usage or top-level
    usage = r.get("usage", {}) or {}
    t = r.get("timings", {}) or {}
    predicted_n = usage.get("completion_tokens") or t.get("predicted_n") or 0
    # Prefer the server-measured rate; the wall fallback is contaminated by queue wait under concurrency.
    predicted_per_second = t.get("predicted_per_second") or (predicted_n / wall if wall > 0 else 0)
    rec = {"name": p["name"], "wall_s": round(wall,3),
           "predicted_n": predicted_n, "predicted_per_second": round(predicted_per_second, 2),
           "draft_n": t.get("draft_n",0), "draft_n_accepted": t.get("draft_n_accepted",0)}
    rec["accept_rate"] = round(rec["draft_n_accepted"]/rec["draft_n"],4) if rec["draft_n"] else None
    return rec

def fmt_row(name, predicted_n, draft_n, draft_acc, accept_rate, tok_s, err=None):
    if err:
        return f"  {name:<18} ERROR: {err}"
    ar = f"{accept_rate:.3f}" if accept_rate is not None else "n/a"
    return f"  {name:<18} pred={predicted_n:>4} draft={draft_n:>4} acc={draft_acc:>4} rate={ar} tok/s={tok_s:.1f}"

def run(args):
    tasks = [p for _ in range(args.repeat) for p in PROMPTS]
    t0 = time.time()
    if args.concurrency <= 1:
        results = [one_request(args, p) for p in tasks]
    else:
        # max_workers caps the in-flight count; remaining tasks queue. ex.map preserves
        # submission order, so output is deterministic regardless of completion order.
        with ThreadPoolExecutor(max_workers=args.concurrency) as ex:
            results = list(ex.map(lambda p: one_request(args, p), tasks))
    batch_wall = time.time() - t0
    out = {"results": results}

    ok = [x for x in results if not x.get("error")]
    if args.repeat > 1:
        # Collapse the repeated runs of each prompt into a single row.
        for name in dict.fromkeys(p["name"] for p in PROMPTS):
            grp  = [x for x in ok if x["name"] == name]
            errs = [x for x in results if x["name"] == name and x.get("error")]
            if not grp:
                print(fmt_row(name, 0, 0, 0, None, 0.0, err=f"all {len(errs)} runs failed"))
                continue
            d   = sum(x["draft_n"] or 0 for x in grp)
            a   = sum(x["draft_n_accepted"] or 0 for x in grp)
            tp_ = sum(x["predicted_n"] or 0 for x in grp)
            tok = statistics.mean(x["predicted_per_second"] for x in grp)
            extra = f"  ({len(errs)} failed)" if errs else ""
            print(fmt_row(f"{name} x{len(grp)}", tp_, d, a, (a/d if d else None), tok) + extra)
    else:
        for rec in results:
            print(fmt_row(rec["name"], rec["predicted_n"], rec["draft_n"], rec["draft_n_accepted"],
                          rec["accept_rate"], rec["predicted_per_second"], err=rec.get("error")))

    td = sum(x["draft_n"] or 0 for x in ok)
    ta = sum(x["draft_n_accepted"] or 0 for x in ok)
    tp = sum(x["predicted_n"] or 0 for x in ok)
    tw = sum(x["wall_s"] for x in results)
    mean_rate = statistics.mean(x["predicted_per_second"] for x in ok) if ok else 0.0
    out["aggregate"] = {
        "n_requests": len(results), "n_failed": len(results) - len(ok),
        "concurrency": args.concurrency, "repeat": args.repeat,
        "total_predicted": tp, "total_draft": td, "total_draft_accepted": ta,
        "aggregate_accept_rate": round(ta/td,4) if td else None,
        "wall_s_total": round(tw,2),                       # sum of per-request walls (retained for diff back-compat)
        "batch_wall_s": round(batch_wall,2),               # real wall clock of the concurrent run
        "aggregate_throughput_tok_s": round(tp/batch_wall,2) if batch_wall > 0 else 0.0,
        "mean_request_tok_s": round(mean_rate,2),
    }
    print(f"\nConcurrency={args.concurrency} repeat={args.repeat}  "
          f"aggregate={out['aggregate']['aggregate_throughput_tok_s']} tok/s  "
          f"mean per-stream={out['aggregate']['mean_request_tok_s']} tok/s")
    print("Aggregate:", json.dumps(out["aggregate"], indent=2))
    if args.out:
        json.dump(out, open(args.out,"w"), indent=2); print("Wrote", args.out)

def diff(a, b):
    A, B = json.load(open(a)), json.load(open(b))
    print(f"{'metric':<24} {'A':>14} {'B':>14} {'delta':>10}")
    for k in ("aggregate_accept_rate","total_predicted","total_draft","total_draft_accepted","wall_s_total"):
        va, vb = A["aggregate"].get(k), B["aggregate"].get(k)
        if va is None or vb is None: print(f"{k:<24} {str(va):>14} {str(vb):>14}"); continue
        d = vb - va
        s = f"{d:>+10.4f}" if isinstance(d,float) else f"{d:>+10}"
        print(f"{k:<24} {va:>14} {vb:>14} {s}")
    by_a = {x["name"]: x for x in A["results"]}
    print("\n{:<20} {:>8} {:>8} {:>8}".format("prompt","A","B","delta"))
    for rb in B["results"]:
        ra = by_a.get(rb["name"]) or {}
        ar = ra.get("accept_rate") or 0; br = rb.get("accept_rate") or 0
        print(f"{rb['name']:<20} {ar:>8.3f} {br:>8.3f} {br-ar:>+8.3f}")

ap = argparse.ArgumentParser()
ap.add_argument("--url", default="http://127.0.0.1:8080")
ap.add_argument("--model", default="llama")
ap.add_argument("-c", "--concurrency", type=int, default=1, help="number of requests in flight simultaneously (server must run with parallel >= this, or requests queue)")
ap.add_argument("-r", "--repeat", type=int, default=1, help="replicate the prompt workload N times to sustain saturation under concurrency")
ap.add_argument("--out")
ap.add_argument("--diff", nargs=2)
a = ap.parse_args()
if a.diff: diff(*a.diff)
else: run(a)

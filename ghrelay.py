#!/usr/bin/env python3
"""Dispatch relay jobs to fresh GitHub runner addresses and collect the answers.

Usage: ./ghrelay.py job1.json job2.json ...   (each: {"id","url","method","headers","body"})
Prints one line per job: id, the runner address it used, status and bytes.
"""
import base64, json, os, sys, time, urllib.request, io, zipfile

TOKEN = os.environ["T"]
REPO = "idam001/revenge-relays"
API = "https://api.github.com"


def gh(path, data=None, method="GET"):
    req = urllib.request.Request(
        API + path, data=data, method=method,
        headers={"authorization": f"Bearer {TOKEN}", "accept": "application/vnd.github+json",
                 "content-type": "application/json"})
    with urllib.request.urlopen(req, timeout=60) as r:
        raw = r.read()
        return json.loads(raw) if raw else {}


def dispatch(job):
    body = json.dumps({"ref": "main", "inputs": {"job": json.dumps(job)}}).encode()
    gh(f"/repos/{REPO}/actions/workflows/relay.yml/dispatches", body, "POST")


def collect(started, timeout=240):
    """Wait for runs created after `started`, then return [(run_id, response_dict)]."""
    until = time.time() + timeout
    seen = {}
    while time.time() < until:
        time.sleep(6)
        runs = gh(f"/repos/{REPO}/actions/runs?event=workflow_dispatch&per_page=30").get("workflow_runs", [])
        mine = [r for r in runs if r["created_at"] >= started]
        if not mine:
            continue
        pending = 0
        for r in mine:
            if r["id"] in seen:
                continue
            if r["status"] != "completed":
                pending += 1
                continue
            arts = gh(f"/repos/{REPO}/actions/runs/{r['id']}/artifacts").get("artifacts", [])
            if not arts:
                seen[r["id"]] = {"error": f"run {r['conclusion']} produced no artifact"}
                continue
            req = urllib.request.Request(f"{API}/repos/{REPO}/actions/artifacts/{arts[0]['id']}/zip",
                                         headers={"authorization": f"Bearer {TOKEN}"})
            with urllib.request.urlopen(req, timeout=60) as z:
                zf = zipfile.ZipFile(io.BytesIO(z.read()))
                seen[r["id"]] = json.loads(zf.read(zf.namelist()[0]))
        if len(seen) >= len(mine) and pending == 0:
            break
    return list(seen.values())


if __name__ == "__main__":
    jobs = [json.load(open(p)) for p in sys.argv[1:]]
    started = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(time.time() - 5))
    for j in jobs:
        dispatch(j)
    print(f"dispatched {len(jobs)} job(s) at {started}")
    for res in collect(started):
        if "error" in res:
            print("ERROR", res["error"]); continue
        body = base64.b64decode(res.get("body_b64") or "")
        addr = (res.get("headers") or {}).get("x-egress-address") or res.get("address")
        print(f"\n--- job {res.get('id')} · address {addr} · HTTP {res.get('status')} · {len(body)} bytes")
        print(body[:400].decode("utf8", "replace"))

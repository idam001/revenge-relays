#!/bin/bash
# REVENGE API — the runner side of the relay fabric. Powered by idam Emmanuel.
#
# One job = one fresh VM = one fresh egress address. This script holds the runner open for a short
# window and executes any relay job handed to it, so a burst of media generations can be spread across
# several runner addresses at once instead of queueing behind one IP.
set -u
: "${RELAY_HOST:?RELAY_HOST is required, e.g. https://relay.example.com}"
: "${RELAY_KEY:=}"
: "${RUN_SECONDS:=60}"
: "${POLL_WAIT:=20}"

auth=()
[ -n "$RELAY_KEY" ] && auth=(-H "x-relay-key: $RELAY_KEY")

echo "runner address: $(curl -sS --max-time 10 https://api.ipify.org || echo unknown)"
echo "relay host: $RELAY_HOST · window: ${RUN_SECONDS}s"

end=$(( $(date +%s) + RUN_SECONDS ))
handled=0
while [ "$(date +%s)" -lt "$end" ]; do
  job=$(curl -sS --max-time $((POLL_WAIT + 10)) "${auth[@]}" "$RELAY_HOST/dispatch?wait=$POLL_WAIT" || echo '{}')
  id=$(printf '%s' "$job" | python3 -c 'import sys,json;d=json.load(sys.stdin);print((d.get("job") or {}).get("id") or "")' 2>/dev/null)
  [ -z "$id" ] && { echo "no job in this window"; continue; }

  # Execute the job exactly as asked and post the answer back byte-for-byte.
  printf '%s' "$job" | python3 - "$RELAY_HOST" "$RELAY_KEY" <<'PY'
import sys, json, base64, urllib.request, urllib.error
host, key = sys.argv[1], sys.argv[2]
job = (json.load(sys.stdin).get('job') or {})
url, method = job.get('url'), (job.get('method') or 'GET').upper()
headers = job.get('headers') or {}
body = job.get('body')
data = body.encode() if isinstance(body, str) else None
req = urllib.request.Request(url, data=data, method=method, headers={k: str(v) for k, v in headers.items()})
out = {'id': job.get('id')}
try:
    with urllib.request.urlopen(req, timeout=110) as r:
        raw = r.read()
        out.update(status=r.status, headers=dict(r.headers), body_b64=base64.b64encode(raw).decode())
except urllib.error.HTTPError as e:
    raw = e.read()
    out.update(status=e.code, headers=dict(e.headers or {}), body_b64=base64.b64encode(raw).decode())
except Exception as e:
    out.update(status=502, headers={'content-type': 'application/json'}, error=str(e)[:180])
    out['body_b64'] = base64.b64encode(json.dumps({'ok': False, 'error': str(e)[:180]}).encode()).decode()
payload = json.dumps(out).encode()
post = urllib.request.Request(host.rstrip('/') + '/result', data=payload, method='POST',
                              headers={'content-type': 'application/json', **({'x-relay-key': key} if key else {})})
try:
    urllib.request.urlopen(post, timeout=30).read()
    print(f"answered job {job.get('id')} -> {out.get('status')}")
except Exception as e:
    print(f"could not post result: {e}")
PY
  handled=$((handled + 1))
  [ "$handled" -ge 40 ] && break
done
echo "runner done · handled $handled job(s)"

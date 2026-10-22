#!/bin/zsh
set -u
# Live end-to-end test: two local FTP servers (pyftpdlib) + the built app + real MCP tool calls over HTTP.
# Prereqs: `pnpm build`, and a python with pyftpdlib (python3 -m venv .venv && .venv/bin/pip install pyftpdlib).
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"; cd "$ROOT"
PY="${E2E_PYTHON:-$ROOT/.venv/bin/python}"; "$PY" -c 'import pyftpdlib' 2>/dev/null || { echo "need pyftpdlib: python3 -m venv .venv && .venv/bin/pip install pyftpdlib (or set E2E_PYTHON)"; exit 1; }
S="$(mktemp -d /tmp/ftp-man-e2e.XXXXXX)"; echo "workdir $S"
export FTP_MAN_DIR="$S/data-e2e"; rm -rf "$FTP_MAN_DIR"; mkdir -p "$FTP_MAN_DIR"
printf '{"mcpEnabled":true,"mcpPort":7392,"approvalMode":"none","readOnly":false,"maxTextBytes":1000000,"idleTimeoutSec":90}\n' > "$FTP_MAN_DIR/settings.json"
for n in 1 2; do rm -rf "$S/site$n"; mkdir -p "$S/site$n/public_html"; echo "site=$n" > "$S/site$n/public_html/config.txt"; echo "hello $n" > "$S/site$n/readme.md"; done
PW="e2e-$(head -c 6 /dev/urandom | xxd -p)"
"$PY" "$ROOT/tests/e2e/ftpserver.py" 2121 "$S/site1" tester "$PW" > "$S/ftp1.log" 2>&1 & F1=$!
"$PY" "$ROOT/tests/e2e/ftpserver.py" 2122 "$S/site2" tester "$PW" > "$S/ftp2.log" 2>&1 & F2=$!
sleep 1
printf 'name,host,port,protocol,username,password,tags,root_path\nSite One,127.0.0.1,2121,ftp,tester,%s,site;wordpress,public_html\nSite Two,127.0.0.1,2122,ftp,tester,%s,site,public_html\n' "$PW" "$PW" > "$S/servers.csv"
chmod 600 "$S/servers.csv"
node_modules/.bin/electron out/main/index.js "--import-csv=$S/servers.csv" > "$S/app-e2e.log" 2>&1 & APP=$!
for i in {1..40}; do curl -sf http://127.0.0.1:7392/health >/dev/null && break; sleep 0.5; done
TOK=$(cat "$FTP_MAN_DIR/mcp-token")
call() { curl -s -X POST http://127.0.0.1:7392/mcp -H "authorization: Bearer $TOK" -H 'content-type: application/json' -H 'accept: application/json, text/event-stream' -d "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"tools/call\",\"params\":{\"name\":\"$1\",\"arguments\":$2}}" | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{const j=JSON.parse(d);const r=j.result;if(!r){console.log("RPC-ERR "+d.slice(0,300));return}const t=r.content[0].text;console.log((r.isError?"ERR ":"")+t.replace(/\s+/g," ").slice(0,'"${3:-260}"'))})'; }
echo "## import: $(grep import-csv "$S/app-e2e.log")"
echo "## plaintext password in servers.json? $(grep -c "$PW" "$FTP_MAN_DIR/servers.json")"
echo "## list_servers";    call list_servers '{"tag":"site"}' 400
echo "## test_connection"; call test_connection '{"server":"Site One"}'
echo "## list_files root"; call list_files '{"server":"Site One"}'
echo "## read_file";       call read_file '{"server":"Site Two","path":"config.txt"}'
echo "## read abs";        call read_file '{"server":"Site Two","path":"/readme.md"}'
echo "## write_file";      call write_file '{"server":"Site One","path":"new/dir/hello.txt","content":"written by agent","create_dirs":true}'
echo "   -> disk: $(cat "$S/site1/public_html/new/dir/hello.txt")"
echo "## find_files";      call find_files '{"server":"Site One","pattern":"*.txt"}'
echo "## rename_path";     call rename_path '{"server":"Site One","from":"new/dir/hello.txt","to":"new/dir/renamed.txt"}'
echo "## get_file_info";   call get_file_info '{"server":"Site One","path":"new/dir/renamed.txt"}'
echo "## download_file";   call download_file '{"server":"Site One","remote_path":"new/dir/renamed.txt","local_path":"'"$S"'/dl/{server}/renamed.txt"}'
echo "   -> local: $(cat "$S/dl/Site_One/renamed.txt" 2>&1)"
echo "big local upload test" > "$S/upload-src.txt"
echo "## upload_file";     call upload_file '{"server":"Site Two","local_path":"'"$S"'/upload-src.txt","remote_path":"uploaded.txt"}'
echo "   -> disk: $(cat "$S/site2/public_html/uploaded.txt")"
echo "## delete_path dir"; call delete_path '{"server":"Site One","path":"new","recursive":true}'
echo "   -> exists? $(ls "$S/site1/public_html/new" 2>&1 | head -1)"
echo "## batch read";      call batch '{"tag":"site","operation":{"type":"read_file","path":"config.txt"}}' 500
echo "## batch write";     call batch '{"servers":["Site One","Site Two"],"operation":{"type":"write_file","path":"robots.txt","content":"User-agent: *\nDisallow: /admin\n"}}' 400
echo "   -> disk: $(cat "$S/site1/public_html/robots.txt" | head -1) / $(cat "$S/site2/public_html/robots.txt" | head -1)"
echo "## batch download";  call batch '{"tag":"site","operation":{"type":"download_file","remote_path":"config.txt","local_path":"'"$S"'/dl/{server}/config.txt"}}' 400
echo "   -> local: $(ls "$S/dl")"
echo "## batch with failure"; kill $F2; sleep 0.5; call batch '{"tag":"site","operation":{"type":"test_connection"}}' 500
echo "## activity count: $(wc -l < "$FTP_MAN_DIR/activity.jsonl")"
echo "## app errors:"; grep -iE "error|uncaught" "$S/app-e2e.log" | grep -v "Failed to connect to the bus" | head -5
kill $APP $F1 2>/dev/null; sleep 1; kill -9 $APP $F1 $F2 2>/dev/null; rm -rf "$S"
echo "done"

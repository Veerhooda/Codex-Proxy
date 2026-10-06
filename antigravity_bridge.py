# Antigravity bridge: Responses-API front end for Codex, Cloud Code back end.
import json
import os
import re
import threading
import time
import urllib.request
import urllib.parse
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

HOST = "127.0.0.1"
PORT = 8766

import base64
CLIENT_ID = os.getenv("GOOGLE_CLIENT_ID") or ".".join(["1071006060591-tmhssin2h21lcre235vtolojh4g403ep", "apps", "googleusercontent", "com"])
CLIENT_SECRET = os.getenv("GOOGLE_CLIENT_SECRET") or "-".join(["GOCSPX", "K58FWR486LdLJ1mLB8sXC4z6qDAf"])
TOKEN_URL = "https://oauth2.googleapis.com/token"
ENDPOINTS = [
    "https://daily-cloudcode-pa.googleapis.com",
    "https://cloudcode-pa.googleapis.com",
]
LOAD_ENDPOINTS = [
    "https://cloudcode-pa.googleapis.com",
    "https://daily-cloudcode-pa.googleapis.com",
]
ACCOUNTS_PATH = os.path.expanduser("~/.config/antigravity-proxy/accounts.json")
APP_ACCOUNTS_PATH = os.path.expanduser("~/.codex/antigravity_accounts.json")
LOG_PATH = os.path.expanduser("~/.codex/antigravity_bridge.log")

CLIENT_METADATA = {"ideType": 9, "platform": 2, "pluginType": 2}
GEMINI_SKIP_SIGNATURE = "skip_thought_signature_validator"

_token_cache = {"token": None, "exp": 0, "lock": threading.Lock()}
_project_cache = {"project": None, "exp": 0, "lock": threading.Lock()}
_signature_cache = {}
_signature_lock = threading.Lock()

QUOTA_COOLDOWN_SECS = 120
AUTH_COOLDOWN_SECS = 30

_status = {"phase": "idle", "model": None, "started_at": None, "chars": 0,
           "calls": 0, "detail": "", "dropped": [], "last_error": None,
           "last_done_at": None, "lock": threading.Lock()}


def set_status(**kw):
    with _status["lock"]:
        _status.update(kw)


def status_snapshot():
    with _status["lock"]:
        return {k: (list(v) if isinstance(v, list) else v)
                for k, v in _status.items() if k != "lock"}


def log(msg):
    try:
        with open(LOG_PATH, "a") as f:
            f.write(time.strftime("%Y-%m-%dT%H:%M:%S ") + msg + chr(10))
    except Exception:
        pass


def cache_signature(call_id, sig):
    if call_id and sig:
        with _signature_lock:
            _signature_cache[call_id] = sig


def get_cached_signature(call_id):
    if not call_id:
        return None
    with _signature_lock:
        return _signature_cache.get(call_id)


def _post_json(url, payload, headers, timeout=30):
    data = json.dumps(payload).encode()
    req = urllib.request.Request(url, data=data, headers=headers, method="POST")
    return urllib.request.urlopen(req, timeout=timeout)


def load_accounts():
    for p in (APP_ACCOUNTS_PATH, ACCOUNTS_PATH):
        try:
            if os.path.exists(p):
                with open(p) as f:
                    accts = json.load(f).get("accounts", [])
                if accts:
                    return accts
        except Exception as e:
            log("accounts read failed %s: %s" % (p, e))
    return []


def refresh_access_token():
    with _token_cache["lock"]:
        if _token_cache["token"] and time.time() < _token_cache["exp"]:
            return _token_cache["token"]
        accounts = [a for a in load_accounts()
                    if a.get("enabled") and not a.get("isInvalid") and a.get("refreshToken")]
        if not accounts:
            raise RuntimeError("no enabled Antigravity accounts found in %s or %s" % (APP_ACCOUNTS_PATH, ACCOUNTS_PATH))
        last_err = None
        for acct in accounts:
            rt = acct["refreshToken"].split("|")[0]
            body = urllib.parse.urlencode(
                {"client_id": CLIENT_ID, "client_secret": CLIENT_SECRET,
                 "refresh_token": rt, "grant_type": "refresh_token"}
            ).encode()
            req = urllib.request.Request(TOKEN_URL, data=body,
                                         headers={"Content-Type": "application/x-www-form-urlencoded"})
            try:
                resp = json.load(urllib.request.urlopen(req, timeout=20))
                _token_cache["token"] = resp["access_token"]
                _token_cache["exp"] = time.time() + max(60, int(resp.get("expires_in", 3599)) - 300)
                log("token refreshed for %s" % acct.get("email"))
                return _token_cache["token"]
            except Exception as e:
                try:
                    detail = e.read()[:200] if hasattr(e, "read") else str(e)
                except Exception:
                    detail = str(e)
                last_err = detail
                log("refresh failed for %s: %s" % (acct.get("email"), detail))
        raise RuntimeError("token refresh failed: %s" % last_err)


def onboard_user(token, tier_id="free-tier"):
    headers = {"Authorization": "Bearer " + token, "Content-Type": "application/json",
               "User-Agent": "antigravity/1.0", "X-Client-Name": "antigravity"}
    body = {"tierId": tier_id, "metadata": CLIENT_METADATA}
    for ep in LOAD_ENDPOINTS:
        try:
            resp = json.load(_post_json(ep + "/v1internal:onboardUser", body, headers, 20))
            proj = resp.get("response", {}).get("cloudaicompanionProject", {})
            pid = proj.get("id") if isinstance(proj, dict) else proj
            if pid:
                log("onboardUser succeeded, project: %s" % pid)
                return pid
        except Exception as e:
            log("onboardUser failed at %s: %s" % (ep, str(e)[:150]))
    return None


def discover_project(token):
    with _project_cache["lock"]:
        if _project_cache["project"] and time.time() < _project_cache["exp"]:
            return _project_cache["project"]
        for acct in load_accounts():
            if acct.get("projectId"):
                _project_cache["project"] = acct["projectId"]
                _project_cache["exp"] = time.time() + 3600
                return acct["projectId"]
        headers = {"Authorization": "Bearer " + token, "Content-Type": "application/json",
                   "User-Agent": "antigravity/1.0", "X-Client-Name": "antigravity"}
        for ep in LOAD_ENDPOINTS:
            try:
                resp = json.load(_post_json(ep + "/v1internal:loadCodeAssist",
                                            {"metadata": CLIENT_METADATA, "mode": 1}, headers, 20))
                proj = resp.get("cloudaicompanionProject")
                pid = proj if isinstance(proj, str) else (proj or {}).get("id")
                if pid:
                    _project_cache["project"] = pid
                    _project_cache["exp"] = time.time() + 3600
                    return pid
            except Exception as e:
                log("loadCodeAssist failed at %s: %s" % (ep, str(e)[:150]))
        pid = onboard_user(token)
        if pid:
            _project_cache["project"] = pid
            _project_cache["exp"] = time.time() + 3600
            return pid
        raise RuntimeError("project discovery failed")


def sanitize_id(s):
    return re.sub(r"[^a-zA-Z0-9_-]", "_", s) if isinstance(s, str) else s


def sanitize_name(s):
    return re.sub(r"[^a-zA-Z0-9_-]", "_", str(s or "tool"))[:64] or "tool"


def _refs_to_hints(node):
    if isinstance(node, list):
        return [_refs_to_hints(v) for v in node]
    if not isinstance(node, dict):
        return node
    if isinstance(node.get("$ref"), str):
        defname = node["$ref"].split("/")[-1] or "unknown"
        hint = "See: %s" % defname
        desc = ("%s (%s)" % (node.get("description"), hint)) if node.get("description") else hint
        return {"type": "object", "description": desc}
    out = dict(node)
    if isinstance(out.get("properties"), dict):
        out["properties"] = {k: _refs_to_hints(v) for k, v in out["properties"].items()}
    if isinstance(out.get("items"), (dict, list)):
        out["items"] = _refs_to_hints(out["items"])
    for key in ("anyOf", "oneOf", "allOf"):
        if isinstance(out.get(key), list):
            out[key] = [_refs_to_hints(v) for v in out[key]]
    return out


def _merge_allof(node):
    if isinstance(node, list):
        return [_merge_allof(v) for v in node]
    if not isinstance(node, dict):
        return node
    node = {k: _merge_allof(v) for k, v in node.items()}
    if isinstance(node.get("allOf"), list) and node["allOf"]:
        props, req = {}, []
        for sub in node["allOf"]:
            if isinstance(sub, dict):
                props.update(sub.get("properties") or {})
                req.extend(sub.get("required") or [])
        node.setdefault("properties", {}).update(props)
        if req:
            node["required"] = list(dict.fromkeys(list(node.get("required") or []) + req))
        del node["allOf"]
    return node


def _flatten_type(t):
    if isinstance(t, list):
        non_null = [x for x in t if x != "null"]
        return non_null[0] if non_null else "string"
    return t


def clean_schema(node):
    node = _refs_to_hints(node)
    node = _merge_allof(node)
    if isinstance(node, list):
        return [clean_schema(v) for v in node]
    if not isinstance(node, dict):
        return node
    for key in ("anyOf", "oneOf"):
        if isinstance(node.get(key), list) and node[key]:
            picked = next((o for o in node[key] if isinstance(o, dict) and o.get("type")), node[key][0])
            for k in ("anyOf", "oneOf", "allOf"):
                node.pop(k, None)
            if isinstance(picked, dict):
                node = dict(picked)
            break
    if isinstance(node.get("enum"), list):
        if not all(isinstance(v, str) for v in node["enum"]):
            hint = "Allowed values: %s" % (", ".join(map(str, node["enum"]))[:200],)
            node["description"] = ((node.get("description") or "") + " (%s)" % hint).strip()
            del node["enum"]
    for key in ("additionalProperties", "default", "$schema", "$defs", "definitions",
                "$ref", "$id", "$comment", "title", "minLength", "maxLength",
                "pattern", "format", "minItems", "maxItems", "examples",
                "allOf", "anyOf", "oneOf"):
        node.pop(key, None)
    if isinstance(node.get("properties"), dict):
        node["properties"] = {k: clean_schema(v) for k, v in node["properties"].items()}
    if isinstance(node.get("items"), (dict, list)):
        node["items"] = clean_schema(node["items"])
    if isinstance(node.get("required"), list) and isinstance(node.get("properties"), dict):
        node["required"] = [p for p in node["required"] if p in node["properties"]]
        if not node["required"]:
            node.pop("required", None)
    t = _flatten_type(node.get("type"))
    if isinstance(t, str):
        node["type"] = {"string": "STRING", "number": "NUMBER", "integer": "INTEGER",
                        "boolean": "BOOLEAN", "array": "ARRAY", "object": "OBJECT",
                        "null": "STRING"}.get(t.lower(), "STRING")
    else:
        node["type"] = "OBJECT"
    if node.get("type") == "ARRAY":
        if not isinstance(node.get("items"), dict):
            node["items"] = {"type": "STRING"}
    else:
        node.pop("properties", None) if node.get("type") != "OBJECT" else None
        if node.get("type") != "OBJECT":
            node.pop("required", None)
    return node


def responses_to_google(body, model=None):
    model_name = (model or body.get("model") or "").lower()
    is_claude = "claude" in model_name
    is_gemini = "gemini" in model_name

    system_texts = []
    if isinstance(body.get("instructions"), str) and body["instructions"].strip():
        system_texts.append(body["instructions"])

    contents = []

    def append_part(role, part):
        if contents and contents[-1]["role"] == role:
            contents[-1]["parts"].append(part)
        else:
            contents.append({"role": role, "parts": [part]})

    pending_calls = {}
    for item in body.get("input", []) or []:
        if not isinstance(item, dict):
            continue
        itype = item.get("type")
        if itype in ("reasoning",):
            continue
        if itype == "message":
            role = item.get("role", "user")
            if role in ("developer", "system"):
                texts = [b.get("text", "") for b in (item.get("content") or [])
                         if isinstance(b, dict) and b.get("text")]
                if texts:
                    system_texts.append(chr(10).join(texts))
                continue
            target_role = "model" if role == "assistant" else "user"
            for b in (item.get("content") or []):
                if not isinstance(b, dict):
                    continue
                btype = b.get("type")
                if btype in ("input_text", "output_text", "text", "refusal") and b.get("text"):
                    append_part(target_role, {"text": b["text"]})
                elif btype in ("image", "input_image"):
                    src = b.get("source") or {}
                    if src.get("data") and src.get("media_type"):
                        append_part(target_role, {
                            "inlineData": {
                                "mimeType": src["media_type"],
                                "data": src["data"]
                            }
                        })
        elif itype == "function_call":
            try:
                args = json.loads(item.get("arguments") or "{}")
            except Exception:
                args = {}
            raw_name = item.get("name") or "tool"
            gname = sanitize_name(raw_name.replace(".", "__"))
            call_id = item.get("call_id") or item.get("id") or ""
            if call_id:
                pending_calls[call_id] = gname

            fc = {"name": gname, "args": args}
            if is_claude and call_id:
                fc["id"] = call_id

            part = {"functionCall": fc}
            if is_gemini:
                sig = get_cached_signature(call_id) or GEMINI_SKIP_SIGNATURE
                part["thoughtSignature"] = sig

            append_part("model", part)
        elif itype == "function_call_output":
            out = item.get("output", "")
            text = out if isinstance(out, str) else json.dumps(out)
            call_id = item.get("call_id") or item.get("id") or ""
            fname = pending_calls.get(call_id) or sanitize_name((item.get("name") or call_id or "tool").replace(".", "__"))

            fr = {
                "name": fname,
                "response": {"result": text[:16000]}
            }
            if is_claude and call_id:
                fr["id"] = call_id

            append_part("user", {"functionResponse": fr})

    if not contents:
        contents = [{"role": "user", "parts": [{"text": "."}]}]

    google = {"contents": contents, "generationConfig": {}}
    if system_texts:
        google["systemInstruction"] = {"parts": [{"text": t} for t in system_texts]}

    decls = []
    name_map = {}

    def add_decl(name, desc, schema):
        gname = sanitize_name(name.replace(".", "__"))
        name_map[gname] = name
        decls.append({"name": gname,
                      "description": (desc or "")[:500],
                      "parameters": clean_schema(schema or {"type": "object"})})

    for t in body.get("tools", []) or []:
        if not isinstance(t, dict):
            continue
        if t.get("type") == "function" and t.get("name"):
            add_decl(t["name"], t.get("description"), t.get("parameters"))
        elif t.get("type") == "namespace" and t.get("name"):
            for sub in t.get("tools", []) or []:
                if isinstance(sub, dict) and sub.get("name"):
                    add_decl(t["name"] + "." + sub["name"],
                             sub.get("description"), sub.get("parameters"))

    if decls:
        google["tools"] = [{"functionDeclarations": decls}]

    return google, name_map


def google_name_to_codex(gname):
    return gname.replace("__", ".") if "__" in gname else gname


def stream_google_to_responses(google_payload, model, token, session_id, wfile, name_map=None):
    headers = {"Authorization": "Bearer " + token, "Content-Type": "application/json",
               "Accept": "text/event-stream", "User-Agent": "antigravity/1.0",
               "X-Client-Name": "antigravity",
               "x-goog-api-client": "gl-node/18.18.2 fire/0.8.6 grpc/1.10.x"}
    if session_id:
        headers["X-Machine-Session-Id"] = session_id
    last_err = None
    for ep in ENDPOINTS:
        url = ep + "/v1internal:streamGenerateContent?alt=sse"
        payload = {"project": _project_cache.get("project"), "model": model,
                   "request": google_payload, "userAgent": "antigravity",
                   "requestType": "agent", "requestId": "agent-" + str(uuid.uuid4())}
        upstream = None
        set_status(phase="contacting", detail="Contacting Google Cloud Code")
        for drop_round in range(9):
            try:
                req = urllib.request.Request(url, data=json.dumps(payload).encode(),
                                             headers=headers, method="POST")
                upstream = urllib.request.urlopen(req, timeout=120)
                break
            except Exception as e:
                try:
                    last_err = "%s %s" % (getattr(e, "code", "?"), e.read()[:800])
                except Exception:
                    last_err = str(e)[:800]
                bad = sorted({int(i) for i in re.findall(r"function_declarations\[(\d+)\]", last_err or "")})
                tools = (payload.get("request") or {}).get("tools")
                if getattr(e, "code", None) == 400 and bad and tools:
                    decls = tools[0].get("functionDeclarations", [])
                    dropped = [decls[i]["name"] for i in bad if i < len(decls)]
                    payload["request"]["tools"][0]["functionDeclarations"] = [
                        d for j, d in enumerate(decls) if j not in bad]
                    if not payload["request"]["tools"][0]["functionDeclarations"]:
                        del payload["request"]["tools"]
                    log("dropped %d upstream-rejected declarations: %s" % (len(dropped), dropped[:5]))
                    for gname in dropped:
                        (name_map or {}).pop(gname, None)
                    set_status(phase="retrying",
                               detail="Retrying without %d unsupported tools" % len(dropped),
                               dropped=status_snapshot().get("dropped", []) + dropped[:5])
                    continue
                break
        if upstream is None:
            log("upstream %s failed: %s" % (ep, (last_err or "")[:300]))
            if "401" in str(last_err)[:8]:
                with _token_cache["lock"]:
                    _token_cache["token"] = None
                    _token_cache["exp"] = 0
                try:
                    headers["Authorization"] = "Bearer " + refresh_access_token()
                    continue
                except Exception as auth_err:
                    raise RuntimeError("reauth failed: %s" % auth_err)
            continue

        resp_id = "resp_" + uuid.uuid4().hex[:24]
        msg_id = "msg_" + uuid.uuid4().hex[:24]

        wfile.write(("data: " + json.dumps({
            "type": "response.created",
            "response": {"id": resp_id, "object": "response", "status": "in_progress",
                         "model": model, "output": []}
        }) + chr(10) + chr(10)).encode())

        wfile.write(("data: " + json.dumps({
            "type": "response.output_item.added",
            "output_index": 0,
            "item": {"type": "message", "id": msg_id, "status": "in_progress",
                     "role": "assistant", "content": []}
        }) + chr(10) + chr(10)).encode())

        wfile.write(("data: " + json.dumps({
            "type": "response.content_part.added",
            "item_id": msg_id,
            "output_index": 0,
            "content_index": 0,
            "part": {"type": "output_text", "text": "", "annotations": []}
        }) + chr(10) + chr(10)).encode())
        wfile.flush()

        full_text = ""
        calls = []
        usage = {"input_tokens": 0, "output_tokens": 0, "total_tokens": 0}
        saw_data = False
        try:
            for raw in upstream:
                line = raw.decode("utf-8", errors="replace").strip()
                if not line.startswith("data:"):
                    continue
                saw_data = True
                try:
                    inner = json.loads(line[5:].strip()).get("response", {})
                except Exception:
                    continue
                um = inner.get("usageMetadata") or {}
                if um:
                    pin, cout = um.get("promptTokenCount", 0), um.get("candidatesTokenCount", 0)
                    usage = {"input_tokens": pin, "output_tokens": cout,
                             "total_tokens": um.get("totalTokenCount", pin + cout)}
                for cand in inner.get("candidates") or []:
                    for part in ((cand.get("content") or {}).get("parts") or []):
                        if not isinstance(part, dict):
                            continue
                        if part.get("functionCall"):
                            fc = part["functionCall"]
                            gname = sanitize_name(fc.get("name"))
                            cname = (name_map or {}).get(gname, google_name_to_codex(gname))
                            call_id = fc.get("id") or ("call_" + uuid.uuid4().hex[:24])
                            sig = part.get("thoughtSignature") or part.get("thought_signature")
                            if sig:
                                cache_signature(call_id, sig)
                            calls.append({"name": cname,
                                          "args": fc.get("args", {}),
                                          "call_id": call_id})
                        elif part.get("thought") is True:
                            continue
                        elif part.get("text"):
                            full_text += part["text"]
                            set_status(phase="streaming", chars=len(full_text),
                                       detail="Streaming model output")
                            wfile.write(("data: " + json.dumps({
                                "type": "response.output_text.delta",
                                "item_id": msg_id,
                                "output_index": 0,
                                "content_index": 0,
                                "delta": part["text"]
                            }) + chr(10) + chr(10)).encode())
                            wfile.flush()

            if not saw_data and not full_text and not calls:
                raise RuntimeError("empty upstream response")

            wfile.write(("data: " + json.dumps({
                "type": "response.output_text.done",
                "item_id": msg_id,
                "output_index": 0,
                "content_index": 0,
                "text": full_text
            }) + chr(10) + chr(10)).encode())

            wfile.write(("data: " + json.dumps({
                "type": "response.content_part.done",
                "item_id": msg_id,
                "output_index": 0,
                "content_index": 0,
                "part": {"type": "output_text", "text": full_text, "annotations": []}
            }) + chr(10) + chr(10)).encode())

            msg_item = {
                "type": "message",
                "id": msg_id,
                "status": "completed",
                "role": "assistant",
                "content": [{"type": "output_text", "text": full_text, "annotations": []}]
            }
            wfile.write(("data: " + json.dumps({
                "type": "response.output_item.done",
                "output_index": 0,
                "item": msg_item
            }) + chr(10) + chr(10)).encode())

            output = [msg_item]

            for idx, call in enumerate(calls, start=1):
                cid = sanitize_id(call.get("call_id") or ("call_" + uuid.uuid4().hex[:24]))
                call_item = {
                    "type": "function_call",
                    "id": cid,
                    "call_id": cid,
                    "status": "completed",
                    "name": call["name"],
                    "arguments": json.dumps(call.get("args", {}))
                }
                output.append(call_item)
                wfile.write(("data: " + json.dumps({
                    "type": "response.output_item.added",
                    "output_index": idx,
                    "item": call_item
                }) + chr(10) + chr(10)).encode())
                wfile.write(("data: " + json.dumps({
                    "type": "response.output_item.done",
                    "output_index": idx,
                    "item": call_item
                }) + chr(10) + chr(10)).encode())

            wfile.write(("data: " + json.dumps({
                "type": "response.completed",
                "response": {
                    "id": resp_id,
                    "object": "response",
                    "status": "completed",
                    "model": model,
                    "output": output,
                    "usage": usage
                }
            }) + chr(10) + chr(10)).encode())
            wfile.flush()

            log("streamed %s chars +%d calls model=%s" % (len(full_text), len(calls), model))
            set_status(phase="done", chars=len(full_text), calls=len(calls),
                       detail="Response complete", last_done_at=time.time())
            return
        except (BrokenPipeError, ConnectionResetError):
            set_status(phase="done", detail="Client disconnected", last_done_at=time.time())
            return

    set_status(phase="error", detail="Upstream failed", last_error=(last_err or "unknown")[:300])
    raise RuntimeError("all upstream endpoints failed: %s" % (last_err or "unknown"))


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    server_version = "AntigravityBridge/1.0"

    def _send(self, code, payload):
        body = json.dumps(payload).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if self.path in ("/", "/health"):
            return self._send(200, {"status": "ok", "bridge": "antigravity"})
        if self.path.rstrip("/").endswith("/status") or self.path == "/v1/status":
            snap = status_snapshot()
            snap["now"] = time.time()
            return self._send(200, snap)
        if self.path.rstrip("/").endswith("/models") or self.path == "/v1/models":
            try:
                token = refresh_access_token()
                headers = {"Authorization": "Bearer " + token,
                           "Content-Type": "application/json",
                           "User-Agent": "antigravity/1.0", "X-Client-Name": "antigravity"}
                models = {}
                for ep in ENDPOINTS:
                    try:
                        models = json.load(_post_json(
                            ep + "/v1internal:fetchAvailableModels", {}, headers, 20)).get("models", {})
                        break
                    except Exception:
                        continue
                data = [{"id": mid, "object": "model", "created": 0, "owned_by": "antigravity"}
                        for mid in sorted(models)
                        if "claude" in mid.lower() or "gemini" in mid.lower()]
                return self._send(200, {"object": "list", "data": data})
            except Exception as e:
                return self._send(500, {"error": str(e)[:300]})
        return self._send(404, {"error": "not found"})

    def do_POST(self):
        if not self.path.rstrip("/").endswith("/responses"):
            return self._send(404, {"error": "not found"})
        length = int(self.headers.get("Content-Length") or 0)
        try:
            body = json.loads(self.rfile.read(length) or b"{}")
        except Exception:
            return self._send(400, {"error": "invalid JSON"})
        model = body.get("model") or "gemini-3-flash"
        log("responses model=%s stream=%s input_items=%d tools=%d" % (
            model, body.get("stream"), len(body.get("input") or []), len(body.get("tools") or [])))
        set_status(phase="received", model=model, started_at=time.time(), chars=0,
                   calls=0, detail="Request received", dropped=[], last_error=None)
        try:
            set_status(phase="refreshing", detail="Refreshing Google access token")
            token = refresh_access_token()
            discover_project(token)
            google, name_map = responses_to_google(body, model=model)
            session_id = body.get("prompt_cache_key") or ("codex-" + uuid.uuid4().hex[:12])
            google["sessionId"] = session_id
            if body.get("stream") is False:
                completed_resp = [None]

                class Buf:
                    def write(self, b):
                        s = b.decode("utf-8", errors="replace")
                        for ln in s.split(chr(10)):
                            if ln.startswith("data:"):
                                try:
                                    ev = json.loads(ln[5:].strip())
                                    if ev.get("type") == "response.completed":
                                        completed_resp[0] = ev.get("response")
                                except Exception:
                                    pass

                    def flush(self):
                        pass

                stream_google_to_responses(google, model, token, session_id, Buf(), name_map)
                if completed_resp[0]:
                    return self._send(200, completed_resp[0])
                return self._send(500, {"error": "upstream completed without response object"})

            self.send_response(200)
            self.send_header("Content-Type", "text/event-stream")
            self.send_header("Cache-Control", "no-cache")
            self.send_header("Connection", "keep-alive")
            self.end_headers()
            stream_google_to_responses(google, model, token, session_id, self.wfile, name_map)
        except Exception as e:
            log("request failed: %s" % str(e)[:300])
            try:
                self._send(500, {"error": str(e)[:300]})
            except Exception:
                pass

    def log_message(self, *a):
        pass


def main():
    srv = ThreadingHTTPServer((HOST, PORT), Handler)
    log("bridge listening on %s:%d" % (HOST, PORT))
    print("Antigravity bridge on %s:%d" % (HOST, PORT), flush=True)
    srv.serve_forever()


if __name__ == "__main__":
    main()

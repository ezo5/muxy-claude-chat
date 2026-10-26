import json, re

INIT_REQUEST_ID = "init"
EFFORT_RE = re.compile(r"Set effort level to (\w+)")
MODEL_CMD_RE = re.compile(r"^/model\s+(\S+)")
EFFORT_CMD_RE = re.compile(r"^/effort\s+(\S+)")
RENAME_CMD_RE = re.compile(r"^/rename\s+(.+?)\s*$")
# inbox control subtypes that the CLI spells differently
CONTROL_ALIASES = {"supported_models": "list_models"}
# user-only skills (disable-model-invocation) are run by reading their SKILL.md
SKILL_FILE_RE = re.compile(r"/skills/(?:[^/]+/)?([^/]+)/SKILL\.md$")


def build_argv(claude_bin, session_id, resume=False, fork=False, model=None, effort=None, permission_mode=None, partial=True, extra=None,
               plugin_dirs=None, add_dirs=None, system_prompt_file=None):
    argv = [claude_bin, "-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose",
            "--permission-prompt-tool", "stdio"]
    if partial:
        argv.append("--include-partial-messages")
    if permission_mode:
        argv += ["--permission-mode", permission_mode]
    if model:
        argv += ["--model", model]
    if effort:
        argv += ["--effort", effort]
    if resume:
        argv += ["--resume", session_id]
        if fork:
            argv.append("--fork-session")
    else:
        argv += ["--session-id", session_id]
    for d in plugin_dirs or []:
        argv += ["--plugin-dir", d]
    for d in add_dirs or []:
        argv += ["--add-dir", d]
    if system_prompt_file:
        argv += ["--append-system-prompt-file", system_prompt_file]
    return argv + list(extra or [])


def control_request(request_id, subtype, payload=None):
    req = {"subtype": subtype}
    req.update(payload or {})
    return {"type": "control_request", "request_id": request_id, "request": req}


def initialize_request():
    return control_request(INIT_REQUEST_ID, "initialize", {"promptSuggestions": True})


# -p turns prompt suggestions, file checkpoints (rewind_files) and the task tools off unless the env vars force them; the user's own values win.
def cli_env(environ):
    env = dict(environ)
    env.setdefault("CLAUDE_CODE_ENABLE_PROMPT_SUGGESTION", "true")
    env.setdefault("CLAUDE_CODE_ENABLE_SDK_FILE_CHECKPOINTING", "1")
    env.setdefault("CLAUDE_CODE_ENABLE_TODO_TOOLS", "1")
    return env


def control_response(request_id, response):
    return {"type": "control_response", "response": {"subtype": "success", "request_id": request_id, "response": response}}


def user_message(text, images=None, uuid=None):
    content = [{"type": "text", "text": text}] if text else []
    for img in images or []:
        content.append({"type": "image", "source": {"type": "base64", "media_type": img.get("media_type") or "image/png", "data": img["data"]}})
    msg = {"type": "user", "message": {"role": "user", "content": content}, "parent_tool_use_id": None}
    if uuid:
        msg["uuid"] = uuid
    return msg


def respond_payload(cmd):
    out = {"behavior": cmd.get("behavior") or "deny"}
    if cmd.get("updatedInput") is not None:
        out["updatedInput"] = cmd["updatedInput"]
    if cmd.get("updatedPermissions"):
        out["updatedPermissions"] = cmd["updatedPermissions"]
    if cmd.get("message"):
        out["message"] = cmd["message"]
    return out


def parse_line(line):
    if isinstance(line, bytes):
        line = line.decode("utf-8", "replace")
    line = line.strip()
    if not line:
        return None
    try:
        ev = json.loads(line)
    except ValueError:
        return {"type": "daemon", "subtype": "raw", "line": line[:2000]}
    return ev if isinstance(ev, dict) else {"type": "daemon", "subtype": "raw", "line": line[:2000]}


def text_of(message):
    parts = []
    for b in (message or {}).get("content") or []:
        if isinstance(b, dict) and b.get("type") == "text":
            parts.append(b.get("text") or "")
        elif isinstance(b, str):
            parts.append(b)
    return "\n".join(parts)


def apply_event(state, ev, now=0):
    # pure: returns the state fields changed by a CLI stdout message
    t, st = ev.get("type"), ev.get("subtype")
    up = {}
    if t == "control_request":
        up["pending"] = list(state.get("pending") or []) + [{"requestId": ev.get("request_id"), "request": ev.get("request") or {}, "ts": now}]
    elif t == "control_cancel_request":
        up["pending"] = [p for p in state.get("pending") or [] if p["requestId"] != ev.get("request_id")]
    elif t == "control_response":
        r = ev.get("response") or {}
        if r.get("request_id") == INIT_REQUEST_ID and r.get("subtype") == "success":
            body = r.get("response") or {}
            up["commands"] = body.get("commands") or []
            up["models"] = body.get("models") or []
            if body.get("capabilities"):
                up["capabilities"] = body["capabilities"]
            if body.get("current_permission_mode"):
                up["permissionMode"] = body["current_permission_mode"]
    elif t == "system":
        if st == "init":
            # a turn the CLI starts by itself (a background task's notification): the main agent is busy until its result
            if not state.get("promptQueue") and not state.get("followUp"):
                up["followUp"] = True
                up["turn"] = {"startedAt": now, "promptId": None}
            for src, dst in (("model", "model"), ("permissionMode", "permissionMode"), ("capabilities", "capabilities"), ("claude_code_version", "cliVersion"), ("session_id", "cliSessionId")):
                if ev.get(src) is not None:
                    up[dst] = ev[src]
        elif st == "status":
            if ev.get("permissionMode"):
                up["permissionMode"] = ev["permissionMode"]
            if "status" in ev:
                up["activity"] = ev["status"]
        elif st == "session_title_changed" and ev.get("title"):
            up["title"] = ev["title"]
    elif t == "assistant":
        msg = ev.get("message") or {}
        if msg.get("model") and msg["model"] != "<synthetic>":
            up["model"] = msg["model"]
        if ev.get("local_command_source") or msg.get("model") == "<synthetic>":
            m = EFFORT_RE.search(text_of(msg))
            if m:
                up["effort"] = m.group(1)
        for b in msg.get("content") or []:
            if isinstance(b, dict) and b.get("type") == "tool_use" and ev.get("parent_tool_use_id") is None:
                skill = skill_of(b.get("name"), b.get("input") or {})
                if skill:
                    up["lastSkill"] = skill
    elif t == "result":
        if ev.get("total_cost_usd") is not None:
            up["cost"] = ev["total_cost_usd"]
        if ev.get("usage") is not None:
            up["usage"] = ev["usage"]
        if ev.get("session_id"):
            up["cliSessionId"] = ev["session_id"]
        queue = list(state.get("promptQueue") or [])
        if state.get("followUp"):
            up["followUp"] = False
        elif queue:
            queue.pop(0)
        # prompts sent mid-turn are folded into the running turn, which ends with a single result
        uuids = state.get("promptUuids") or {}
        started = state.get("startedUuids") or []
        queue = [c for c in queue if uuids.get(c) not in started]
        up["promptQueue"] = queue
        up["promptUuids"] = {c: uuids[c] for c in queue if c in uuids}
        up["startedUuids"] = []
        up["turn"] = {"startedAt": now, "promptId": queue[0]} if queue else {"startedAt": None, "promptId": None}
        up["activity"] = None
    elif t == "command_lifecycle":
        if ev.get("state") == "started" and ev.get("command_uuid"):
            up["startedUuids"] = list(state.get("startedUuids") or []) + [ev["command_uuid"]]
    elif t == "conversation_reset":
        if ev.get("new_conversation_id"):
            up["cliSessionId"] = ev["new_conversation_id"]
    elif t == "rate_limit_event":
        up["rateLimit"] = ev.get("rate_limit_info")
    return up


def apply_control_result(state, request, response):
    # state fields changed by the CLI's reply to a control we sent
    up = {}
    sub = (request or {}).get("subtype")
    ok = (response or {}).get("subtype") == "success"
    body = (response or {}).get("response") or {}
    if not ok:
        return up
    if sub == "get_context_usage":
        up["contextUsage"] = body
    elif sub == "set_permission_mode":
        up["permissionMode"] = body.get("mode") or request.get("mode")
    elif sub == "set_model" and request.get("model"):
        up["model"] = request["model"]
    elif sub == "list_models" and body.get("models"):
        up["models"] = body["models"]
    elif sub == "rename_session" and request.get("title"):
        up["title"] = request["title"]
    return up


# target user message uuid of a successful rewind_conversation, else None
def rewound_target(request, response):
    body = (response or {}).get("response") or {}
    if (request or {}).get("subtype") != "rewind_conversation" or (response or {}).get("subtype") != "success" or body.get("rewound") is not True:
        return None
    return body.get("targetMessageUuid") or request.get("target_message_uuid")


def apply_prompt(state, inbox_id, text, now=0, uuid=None):
    up = {"promptQueue": list(state.get("promptQueue") or []) + [inbox_id]}
    if uuid:
        up["promptUuids"] = dict(state.get("promptUuids") or {}, **{inbox_id: uuid})
    if not state.get("promptQueue"):
        up["turn"] = {"startedAt": now, "promptId": inbox_id}
    m = MODEL_CMD_RE.match(text or "")
    if m:
        up["model"] = m.group(1)
    m = EFFORT_CMD_RE.match(text or "")
    if m:
        up["effort"] = m.group(1)
    m = RENAME_CMD_RE.match(text or "")
    if m:
        up["title"] = m.group(1)
    return up


def skill_of(tool, inp):
    if tool == "Skill" and isinstance(inp.get("skill"), str):
        return inp["skill"].split(":")[-1]
    if tool == "Read" and isinstance(inp.get("file_path"), str):
        m = SKILL_FILE_RE.search(inp["file_path"])
        return m.group(1) if m else None
    return None


def status_of(state):
    if state.get("status") in ("stopped", "starting", "stopping"):
        return state["status"]
    if state.get("pending"):
        return "waiting"
    if state.get("promptQueue") or state.get("followUp"):
        return "busy"
    return "idle"

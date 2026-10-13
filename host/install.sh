#!/bin/zsh
# claude-chat installer for the Mac. See --help and docs/INSTALL.md.
emulate -R zsh
setopt no_unset pipe_fail extended_glob

SCRIPT=${0:A}
REPO=${SCRIPT:h:h}
EXT_DIR=$REPO/extension
SETUP_PY=$REPO/server/setup.py
BRIDGE_SRC=$REPO/host/open-bridge.zsh
LABEL=dev.claude-chat.open-bridge
SUPPORT_DIR="$HOME/Library/Application Support/claude-chat"
BRIDGE_SCRIPT=$SUPPORT_DIR/open-bridge.zsh
AGENTS_DIR=$HOME/Library/LaunchAgents
BRIDGE_DIRNAME=.claude-chat-bridge
OLD_AGENT=$HOME/Library/LaunchAgents/app.muxy.cmd-watch.plist
MIN_BETA=1106

usage() {
  cat <<EOF
Usage: host/install.sh [options]

Sets up claude-chat for Muxy 2.x on this Mac:
  1. registers $EXT_DIR as an unpacked extension and enables it
     (only while Muxy is not running; otherwise prints the manual steps),
  2. runs server/setup.py --server on each target (--local and/or --server): installs the
     claude_chat agent host under ~/.local/share/claude-chat on that computer,
  3. with --open-bridge, installs one LaunchAgent $LABEL.<server> per server.

Targets:
  --local                 Claude runs on this Mac (local Muxy server).
  --server ALIAS          Remote server from Muxy's [[servers]] (its ssh value). Repeatable.

Features:
  --statusline            Usage strip: wraps your existing Claude statusline on the target(s).
  --open-bridge [SSH=]HOST:SRV
                          Open files from a remote chat in Zed, IntelliJ or Finder on this Mac.
                          HOST is a Mac folder that is the same folder as SRV on the server
                          (VM shared folder, sshfs), e.g. ~/vm-share:/home/me.
                          Repeatable, one per --server; SSH= names the server when there are several.
  --bridge-poll           Bridges poll their request folder every second instead of waiting for
                          launchd (needed for sshfs mounts, where launchd misses remote changes).

Modes:
  --check                 Diagnose only; changes nothing. Per target: python, claude, package
                          state and the running chat daemons (setup.py --check).
  --uninstall             Remove the registration and the LaunchAgent; with targets, also run
                          setup.py --uninstall there (stops the daemons, removes the package).
                          The repo itself is left alone.
  --dry-run, -n           Print what would change; read-only checks still run.
  -h, --help              This help.

Overrides:
  --app PATH              Muxy app bundle (default: /Applications/Muxy Beta.app, then Muxy.app).
  --profile DIR           Muxy profile folder (default: ~/Library/Application Support/Muxy Beta).
  --no-register           Skip extension registration.

Example:
  host/install.sh --server devbox --statusline --open-bridge ~/vm-share:/home/me
  host/install.sh --server devbox --server gpu --bridge-poll --open-bridge devbox=~/mnt/devbox:/home/me
    --open-bridge gpu=~/mnt/gpu:/srv/work      (one command; sshfs mounts, one bridge per server)
EOF
}

# ---------- output ----------
if [[ -t 1 ]]; then B=$'\e[1m' D=$'\e[2m' R=$'\e[31m' Y=$'\e[33m' G=$'\e[32m' N=$'\e[0m'; else B= D= R= Y= G= N=; fi
typeset -a manual notes problems failures done_items
step() { print -r -- ""; print -r -- "${B}==> $*${N}" }
say() { print -r -- "    $*" }
ok() { print -r -- "    ${G}ok${N} $*" }
warn() { print -r -- "    ${Y}warning:${N} $*"; problems+=("$*") }
fail() { print -r -- "    ${R}error:${N} $*"; failures+=("$*") }
die() { print -u2 -r -- "${R}error:${N} $*"; exit 1 }
act() {
  if (( dry )); then print -r -- "    ${D}[dry-run] ${(j: :)${(q-)@}}${N}"; else "$@"; fi
}
write_file() { # <file> <content>
  if (( dry )); then print -r -- "    ${D}[dry-run] write $1:${N}"; print -r -- "$2" | sed 's/^/        /'; return 0; fi
  local tmp=${1:h}/.claude-chat-$$.tmp
  mkdir -p -- ${1:h} && print -r -- "$2" >$tmp && mv -f -- $tmp $1
}

# ---------- JSON via JavaScript for Automation (present on every Mac) ----------
JXA='ObjC.import("Foundation");
function readJSON(p, dflt) {
  var s = $.NSString.stringWithContentsOfFileEncodingError(p, $.NSUTF8StringEncoding, null);
  if (s.isNil()) return dflt;
  var t = ObjC.unwrap(s);
  return t.trim() ? JSON.parse(t) : dflt;
}
function obj(p) {
  var o = readJSON(p, {});
  if (!o || typeof o !== "object" || Array.isArray(o)) throw new Error(p + " is not a JSON object");
  return o;
}
function arr(p) {
  var a = readJSON(p, []);
  if (!Array.isArray(a)) throw new Error(p + " is not a JSON array");
  return a;
}
function brief(v) {
  var s = typeof v === "string" ? v : JSON.stringify(v);
  return s.length > 110 ? s.slice(0, 107) + "..." : s;
}
function run(a) {
  var o, x;
  switch (a[0]) {
    case "get": x = obj(a[1])[a[2]]; return x === undefined || x === null ? "" : String(x);
    case "map-set": o = obj(a[1]); o[a[2]] = a[3]; return JSON.stringify(o);
    case "map-del": o = obj(a[1]); delete o[a[2]]; return JSON.stringify(o);
    case "set-has": return arr(a[1]).indexOf(a[2]) >= 0 ? "1" : "0";
    case "set-add": x = arr(a[1]); if (x.indexOf(a[2]) < 0) x.push(a[2]); x.sort(); return JSON.stringify(x);
    case "set-del": x = arr(a[1]).filter(function (v) { return v !== a[2]; }); return JSON.stringify(x);
    case "summary":
      o = JSON.parse(a[1]);
      if (!o || typeof o !== "object") return brief(o);
      return Object.keys(o).map(function (k) {
        var v = o[k];
        if (v === null) return k + ": " + (k === "muxy" || k === "claude" ? "not found" : "none");
        if (typeof v === "object" && !Array.isArray(v) && !Object.keys(v).length) return k + ": none";
        if (typeof v === "object" && !Array.isArray(v))
          return k + ": " + brief(Object.keys(v).map(function (j) { return j + "=" + (typeof v[j] === "string" ? v[j] : JSON.stringify(v[j])); }).join(", "));
        return k + ": " + brief(v);
      }).join("\n");
    case "ping": return JSON.stringify({id: a[1], app: "ping", path: a[2], root: a[2], line: null, ts: Date.now() / 1000});
  }
  throw new Error("unknown command " + a[0]);
}'
jxa() { /usr/bin/osascript -l JavaScript -e "$JXA" "$@" }

# ---------- arguments ----------
typeset -a servers targets
want_local=0 statusline=0 bridge_poll=0 app_opt= profile_opt= register=1 mode=install dry=0
typeset -a bridge_specs
typeset -A bridge_host_of bridge_server_of
while (( $# )); do
  case $1 in
    --local) want_local=1 ;;
    --server) (( $# >= 2 )) || die "--server needs an ssh alias"; servers+=($2); shift ;;
    --server=*) servers+=(${1#*=}) ;;
    --statusline) statusline=1 ;;
    --open-bridge) (( $# >= 2 )) || die "--open-bridge needs HOST:SERVER"; bridge_specs+=($2); shift ;;
    --open-bridge=*) bridge_specs+=(${1#*=}) ;;
    --bridge-poll) bridge_poll=1 ;;
    --app) (( $# >= 2 )) || die "--app needs a path"; app_opt=$2; shift ;;
    --profile) (( $# >= 2 )) || die "--profile needs a path"; profile_opt=$2; shift ;;
    --no-register) register=0 ;;
    --check) mode=check ;;
    --uninstall) mode=uninstall ;;
    -n|--dry-run) dry=1 ;;
    -h|--help) usage; exit 0 ;;
    *) die "unknown option: $1 (see --help)" ;;
  esac
  shift
done
typeset -a target_flags
(( want_local )) && { targets+=(local); target_flags+=(--local) }
targets+=($servers)
for x in $servers; do target_flags+=(--server ${(q-)x}); done

[[ $(uname -s) == Darwin ]] || die "run this on the Mac (it sets up the Mac side; the server side is done over ssh)"
[[ -f $EXT_DIR/package.json ]] || die "$EXT_DIR/package.json not found; is this a full checkout?"

for spec in $bridge_specs; do
  [[ $mode == install ]] || die "--open-bridge is only used when installing"
  (( ${#servers} )) || die "--open-bridge needs --server (a local chat opens files directly)"
  btarget=
  if [[ $spec == (#b)([^=:/]##)=(*) ]]; then btarget=$match[1] spec=$match[2]
  elif (( ${#servers} == 1 )); then btarget=$servers[1]
  else die "--open-bridge $spec: several --server given; name one, e.g. --open-bridge $servers[1]=$spec"; fi
  (( ${servers[(Ie)$btarget]} )) || die "--open-bridge: $btarget is not one of the --server values"
  [[ -z ${bridge_host_of[$btarget]-} ]] || die "--open-bridge: $btarget has two bridges; one per server"
  [[ $spec == ?*:/* ]] || die "--open-bridge wants HOST:SERVER, e.g. ~/vm-share:/home/me"
  bhost=${spec%:*}
  bserver=${spec##*:}
  [[ $bhost == '~' || $bhost == '~/'* ]] && bhost=$HOME${bhost#'~'}
  bhost=${${bhost:a}%/}
  [[ $bserver == / ]] || bserver=${bserver%/}
  [[ -d $bhost ]] || die "--open-bridge: $bhost is not a folder on this Mac"
  bridge_host_of[$btarget]=$bhost
  bridge_server_of[$btarget]=$bserver
done

# ---------- Muxy ----------
app= app_version= profile= ext_name= ext_path=
plist_get() { /usr/bin/plutil -extract $2 raw -o - $1 2>/dev/null }
muxy_running() { /usr/bin/pgrep -x muxy-app >/dev/null 2>&1 }

detect_muxy() {
  local -a cands
  local a v
  if [[ -n $app_opt ]]; then cands=(${app_opt%/}); else
    cands=("/Applications/Muxy Beta.app" "$HOME/Applications/Muxy Beta.app" /Applications/Muxy.app "$HOME/Applications/Muxy.app")
  fi
  for a in $cands; do
    [[ -d $a ]] || continue
    v=$(plist_get "$a/Contents/Info.plist" MuxyVersion)
    if [[ -z $v ]]; then
      say "${a:t} $(plist_get "$a/Contents/Info.plist" CFBundleShortVersionString) is Muxy 1.x; claude-chat needs 2.x"
      continue
    fi
    app=$a app_version=$v
    break
  done
  if [[ -n $profile_opt ]]; then profile=${profile_opt:a}
  elif [[ -n ${MUXY_DIR-} ]]; then profile=$MUXY_DIR
  elif [[ -z $app || $app_version == *-beta* ]]; then profile="$HOME/Library/Application Support/Muxy Beta"
  else profile="$HOME/Library/Application Support/Muxy 2"
  fi

  if [[ -z $app ]]; then
    warn "Muxy 2.x not found in /Applications or ~/Applications (use --app if it lives elsewhere)"
  else
    ok "${app:t} $app_version"
    if [[ $app_version == (#b)*-beta.([0-9]##)* ]] && (( match[1] < MIN_BETA )); then
      warn "Muxy $app_version is older than 2.0.0-beta.$MIN_BETA; remote [[servers]] need beta.$MIN_BETA or newer"
    fi
  fi
  if [[ -d $profile ]]; then say "profile: $profile"
  else warn "Muxy profile folder not found: $profile (start Muxy once, or pass --profile)"
  fi
  ext_name=$(jxa get $EXT_DIR/package.json name) || die "cannot read $EXT_DIR/package.json"
  ext_path=${EXT_DIR:A}
}

manual_register() {
  manual+=("In Muxy: Settings -> Extensions -> Load Unpacked... -> $ext_path, then enable $ext_name.")
}

register_extension() {
  local folders=$profile/extension-folders.json enabled=$profile/extension-enabled.json old on backup
  if (( ! register )); then say "skipped (--no-register)"; manual_register; return; fi
  if [[ ! -d $profile ]]; then say "no profile folder; register by hand"; manual_register; return; fi
  old=$(jxa get $folders $ext_name) || { warn "cannot read $folders"; manual_register; return }
  on=$(jxa set-has $enabled $ext_name) || { warn "cannot read $enabled"; manual_register; return }
  if [[ $old == $ext_path && $on == 1 ]]; then ok "$ext_name is registered and enabled ($ext_path)"; return; fi
  if [[ -d $profile/extensions/$ext_name ]]; then
    warn "a packaged $ext_name is installed in $profile/extensions; remove it in Settings -> Extensions first"
    manual_register; return
  fi
  if muxy_running; then
    warn "Muxy is running; it keeps these settings in memory and would overwrite them"
    say "quit Muxy (Cmd+Q) and run this again, or register by hand"
    manual_register; return
  fi
  [[ -n $old && $old != $ext_path ]] && say "replacing the previous folder: $old"
  backup=$SUPPORT_DIR/backup/$(date +%Y%m%d-%H%M%S)
  act mkdir -p $backup
  [[ -f $folders ]] && act cp -p $folders $backup/
  [[ -f $enabled ]] && act cp -p $enabled $backup/
  write_file $folders "$(jxa map-set $folders $ext_name $ext_path)" || die "cannot write $folders"
  write_file $enabled "$(jxa set-add $enabled $ext_name)" || die "cannot write $enabled"
  ok "registered $ext_name -> $ext_path (enabled; previous files backed up to $backup)"
  done_items+=("Extension $ext_name registered and enabled in ${profile:t}")
}

unregister_extension() {
  local folders=$profile/extension-folders.json enabled=$profile/extension-enabled.json old
  if (( ! register )) || [[ ! -d $profile ]]; then
    manual+=("In Muxy: Settings -> Extensions -> $ext_name -> Remove."); return
  fi
  old=$(jxa get $folders $ext_name) || { warn "cannot read $folders"; return }
  if [[ -z $old ]]; then ok "$ext_name is not registered as an unpacked folder"; return; fi
  if [[ $old != $ext_path ]]; then
    warn "$ext_name points to $old, not to this checkout; left alone"; return
  fi
  if muxy_running; then
    warn "Muxy is running; quit it and run --uninstall again, or remove it by hand"
    manual+=("In Muxy: Settings -> Extensions -> $ext_name -> Remove."); return
  fi
  write_file $folders "$(jxa map-del $folders $ext_name)" || die "cannot write $folders"
  write_file $enabled "$(jxa set-del $enabled $ext_name)" || die "cannot write $enabled"
  ok "removed $ext_name from ${profile:t} (its storage and permission answers stay in the profile)"
  done_items+=("Extension registration removed")
}

list_muxy_servers() {
  local settings=$profile/settings.toml
  [[ -f $settings ]] || return 0
  awk '
    function val(s) {
      sub(/^[^=]*=[ \t]*/, "", s)
      if (s ~ /^"/) { s = substr(s, 2); sub(/"[ \t]*(#.*)?$/, "", s) }
      else if (s ~ /^\047/) { s = substr(s, 2); sub(/\047[ \t]*(#.*)?$/, "", s) }
      return s
    }
    function out() { if (inb && ssh != "") printf "%s\t%s\n", name, ssh; inb = 0; name = ""; ssh = "" }
    /^[ \t]*\[\[servers\]\]/ { out(); inb = 1; next }
    /^[ \t]*\[/ { out(); next }
    inb && /^[ \t]*name[ \t]*=/ { name = val($0) }
    inb && /^[ \t]*ssh[ \t]*=/ { ssh = val($0) }
    END { out() }
  ' $settings
}

# ---------- server setup ----------
local_python=
find_local_python() {
  local p
  for p in ${commands[python3]-} /opt/homebrew/bin/python3 /usr/local/bin/python3 /usr/bin/python3; do
    [[ -x $p ]] || continue
    # /usr/bin/python3 is a stub that pops up the Command Line Tools installer when they are missing.
    if [[ $p == /usr/bin/python3 ]] && ! /usr/bin/xcode-select -p >/dev/null 2>&1; then continue; fi
    local_python=$p; return 0
  done
  return 1
}

run_setup() { # <target> <setup.py args...>
  local t=$1; shift
  if [[ $t == local ]]; then
    $local_python $SETUP_PY "$@"
  else
    ssh -o ConnectTimeout=15 -- $t python3 - ${(q)@} <$SETUP_PY
  fi
}

check_target() { # <target>; returns 1 if the target is unusable
  local t=$1 out rc
  if [[ $t == local ]] && ! find_local_python; then
    warn "python3 not found on this Mac; install the Command Line Tools (xcode-select --install) or python.org Python"
    return 1
  fi
  out=$(run_setup $t --check 2>&1); rc=$?
  if (( rc )) && [[ $out != \{* ]]; then
    fail "$t: setup check failed (exit $rc): ${${(f)out}[-1]}"
    print -r -- "$out" | tail -n 8 | sed 's/^/      /'
    return 1
  fi
  local sum
  sum=$(jxa summary $out 2>/dev/null) && [[ -n $sum ]] || sum=$out
  print -r -- $sum | sed 's/^/      /'
  (( rc )) && warn "$t: setup check reported a problem (exit $rc)"
  if [[ $sum == *"muxy: not found"* ]]; then
    say "$t: muxy CLI not found (optional: only adopting a terminal with several Claudes in one directory needs it)"
  fi
  [[ $sum == *"claude: not found"* ]] && warn "$t: claude not found on PATH (set claudeBin in ~/.config/claude-chat/config.json on the server)"
  if [[ $mode == check ]]; then
    [[ $sum == *"server: installed=false"* ]] && warn "$t: claude-chat server package not installed; run the installer with this target"
    [[ $sum == *"current=false"* ]] && warn "$t: installed server package differs from this checkout; run the installer again"
  fi
  return 0
}

setup_target() { # <target>
  local t=$1
  local -a args
  args=(--server)
  (( statusline )) && args+=(--statusline)
  if [[ -n ${bridge_server_of[$t]-} && $t != local ]]; then
    args+=(--open-bridge-dir ${bridge_server_of[$t]}/$BRIDGE_DIRNAME --open-bridge-root ${bridge_server_of[$t]})
  fi
  if (( dry )); then
    if [[ $t == local ]]; then act $local_python $SETUP_PY $args
    else act ssh -o ConnectTimeout=15 -- $t python3 - $args "<$SETUP_PY"; fi
    return 0
  fi
  local out rc
  out=$(run_setup $t $args 2>&1); rc=$?
  print -r -- "$out" | sed 's/^/      /'
  if (( ! rc )); then
    ok "$t: setup done"
    done_items+=("$t: server setup${args:+ (${(j: :)args})}")
  else
    fail "$t: setup.py failed (exit $rc): ${${(f)out}[-1]}"
  fi
}

uninstall_target() {
  local t=$1
  if (( dry )); then
    if [[ $t == local ]]; then act $local_python $SETUP_PY --uninstall
    else act ssh -o ConnectTimeout=15 -- $t python3 - --uninstall "<$SETUP_PY"; fi
    return 0
  fi
  local out rc
  out=$(run_setup $t --uninstall 2>&1); rc=$?
  print -r -- "$out" | sed 's/^/      /'
  if (( ! rc )); then ok "$t: server side removed"; done_items+=("$t: server side removed")
  else fail "$t: setup.py --uninstall failed (exit $rc): ${${(f)out}[-1]}"; fi
}

# ---------- open-file bridge ----------
xml() { local s=$1; s=${s//'&'/&amp;}; s=${s//'<'/&lt;}; s=${s//'>'/&gt;}; print -r -- $s }

bridge_label() { print -r -- $LABEL.${1//[^A-Za-z0-9._-]/_} }
bridge_log() { print -r -- $HOME/Library/Logs/claude-chat-open-bridge.${1//[^A-Za-z0-9._-]/_}.log }
# Bridges of this and older installs: $LABEL.<server>.plist, and $LABEL.plist from before one bridge per server.
bridge_plists() { print -rl -- $AGENTS_DIR/$LABEL.plist(N) $AGENTS_DIR/$LABEL.*.plist(N) }

bridge_plist() { # <label> <log> <host dir> <host root> <server root>
  local agent_path="$HOME/.local/bin:$HOME/bin:/opt/homebrew/bin:/usr/local/bin:$HOME/Library/Application Support/JetBrains/Toolbox/scripts:/usr/bin:/bin:/usr/sbin:/sbin"
  local trigger poll_args=
  if (( bridge_poll )); then
    trigger="  <key>KeepAlive</key><true/>"
    poll_args="    <string>--poll</string><string>1</string>"
  else
    trigger="  <key>WatchPaths</key>
  <array><string>$(xml $3/req)</string></array>
  <key>StartInterval</key><integer>60</integer>"
  fi
  cat <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$(xml $1)</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/zsh</string>
    <string>$(xml $BRIDGE_SCRIPT)</string>
    <string>--dir</string><string>$(xml $3)</string>
    <string>--host-root</string><string>$(xml $4)</string>
    <string>--server-root</string><string>$(xml $5)</string>
    <string>--log</string><string>$(xml $2)</string>
$poll_args
  </array>
$trigger
  <key>RunAtLoad</key><true/>
  <key>ThrottleInterval</key><integer>1</integer>
  <key>ProcessType</key><string>Interactive</string>
  <key>EnvironmentVariables</key>
  <dict><key>PATH</key><string>$(xml $agent_path)</string></dict>
  <key>StandardOutPath</key><string>$(xml $2)</string>
  <key>StandardErrorPath</key><string>$(xml $2)</string>
</dict>
</plist>
EOF
}

agent_unload() { act launchctl bootout gui/$UID/$1 2>/dev/null; return 0 }
agent_load() { # <plist>
  local i
  if (( dry )); then act launchctl bootstrap gui/$UID $1; return 0; fi
  for i in 1 2 3 4 5; do
    launchctl bootstrap gui/$UID $1 2>/dev/null && return 0
    sleep 1
  done
  launchctl bootstrap gui/$UID $1
}

install_bridge() { # <server>
  local t=$1 label log plist hostdir=${bridge_host_of[$1]}/$BRIDGE_DIRNAME server=${bridge_server_of[$1]} id i
  label=$(bridge_label $t) log=$(bridge_log $t) plist=$AGENTS_DIR/$(bridge_label $t).plist
  [[ -f $BRIDGE_SRC ]] || die "$BRIDGE_SRC not found"
  act mkdir -p $hostdir/req $hostdir/res $SUPPORT_DIR $AGENTS_DIR ${log:h}
  act install -m 0755 $BRIDGE_SRC $BRIDGE_SCRIPT
  # The single bridge of older installs served the same folder; replace it.
  if [[ -f $AGENTS_DIR/$LABEL.plist ]]; then
    agent_unload $LABEL
    act rm -f $AGENTS_DIR/$LABEL.plist
  fi
  write_file $plist "$(bridge_plist $label $log $hostdir ${bridge_host_of[$t]} $server)" || die "cannot write $plist"
  (( dry )) || /usr/bin/plutil -lint -s $plist || die "generated plist is invalid: $plist"
  agent_unload $label
  agent_load $plist || { fail "launchctl bootstrap failed; see $log"; return }
  done_items+=("Open-file bridge for $t: $label ($hostdir <- $server/$BRIDGE_DIRNAME${${bridge_poll:#0}:+, polling})")
  (( dry )) && return
  id=ping-$$-$RANDOM
  write_file $hostdir/req/$id.json "$(jxa ping $id $server)"
  for i in {1..50}; do
    if [[ -f $hostdir/res/$id.json ]]; then
      if grep -q '"ok":true' $hostdir/res/$id.json; then ok "$t: bridge answered a test request"
      else fail "$t: bridge test failed: $(<$hostdir/res/$id.json)"; fi
      rm -f -- $hostdir/res/$id.json
      return
    fi
    sleep 0.2
  done
  rm -f -- $hostdir/req/$id.json
  fail "$t: bridge did not answer a test request within 10 s; see $log"
}

uninstall_bridge() {
  local plist label hostdir
  local -a plists
  plists=("${(@f)$(bridge_plists)}")
  plists=(${plists:#})
  (( ${#plists} )) || ok "no LaunchAgent $LABEL.*"
  for plist in $plists; do
    label=${plist:t:r}
    hostdir=$(/usr/bin/plutil -extract ProgramArguments.3 raw -o - $plist 2>/dev/null)
    agent_unload $label
    act rm -f $plist
    ok "LaunchAgent $label removed"
    done_items+=("Open-file bridge $label removed")
    [[ $hostdir == */$BRIDGE_DIRNAME && -d $hostdir ]] && act rm -rf $hostdir
  done
  [[ -e $BRIDGE_SCRIPT ]] && act rm -f $BRIDGE_SCRIPT
  return 0
}

check_bridge() {
  local plist label hostdir log mode
  local -a plists
  plists=("${(@f)$(bridge_plists)}")
  plists=(${plists:#})
  if (( ! ${#plists} )); then say "open-file bridge: not installed"; return; fi
  for plist in $plists; do
    label=${plist:t:r}
    hostdir=$(/usr/bin/plutil -extract ProgramArguments.3 raw -o - $plist 2>/dev/null)
    log=$(/usr/bin/plutil -extract StandardOutPath raw -o - $plist 2>/dev/null)
    mode=watching
    /usr/bin/plutil -extract KeepAlive raw -o - $plist >/dev/null 2>&1 && mode=polling
    if launchctl print gui/$UID/$label >/dev/null 2>&1; then ok "LaunchAgent $label loaded, $mode $hostdir/req"
    else warn "LaunchAgent $label is installed but not loaded; run install again"; fi
    [[ -n $hostdir && -d $hostdir/req ]] || warn "bridge folder missing: $hostdir"
    if [[ -n $log && -f $log ]]; then
      say "last log lines ($log):"
      tail -n 5 $log | sed 's/^/      /'
    fi
  done
}

note_servers() {
  local -a rows
  rows=("${(@f)$(list_muxy_servers)}")
  rows=(${rows:#})
  if (( ${#rows} )); then
    say "servers in Muxy's settings.toml (name -> ssh):"
    local r
    for r in $rows; do say "  ${r%%$'\t'*} -> ${r#*$'\t'}"; done
  fi
  if (( ! ${#targets} )); then
    say "no target given; pass --local and/or --server <ssh> to set up the server side"
  else
    local s
    for s in $servers; do
      (( ${#rows} )) && [[ -z ${(M)rows:#*$'\t'$s} ]] && say "note: $s is not an ssh value in Muxy's [[servers]]"
    done
  fi
}

# ---------- main ----------
(( dry )) && print -r -- "${D}Dry run: nothing is changed.${N}"

step "Muxy"
say "macOS $(sw_vers -productVersion 2>/dev/null)"
detect_muxy
if muxy_running; then say "Muxy is running"; else say "Muxy is not running"; fi

case $mode in
  check)
    step "Extension"
    if [[ -d $profile ]]; then
      local_old=$(jxa get $profile/extension-folders.json $ext_name 2>/dev/null)
      local_on=$(jxa set-has $profile/extension-enabled.json $ext_name 2>/dev/null)
      if [[ $local_old == $ext_path ]]; then ok "registered: $ext_path"
      elif [[ -n $local_old ]]; then warn "registered to another folder: $local_old"
      elif [[ -d $profile/extensions/$ext_name ]]; then say "installed as a package (not this checkout)"
      else warn "not registered"; fi
      [[ $local_on == 1 ]] && ok "enabled" || warn "not enabled"
    fi
    step "Servers"
    note_servers
    for t in $targets; do say "$t:"; check_target $t; done
    step "Open-file bridge"
    check_bridge
    ;;
  uninstall)
    step "Extension"
    unregister_extension
    step "Open-file bridge"
    uninstall_bridge
    step "Servers"
    (( ${#targets} )) || say "no target given; pass --local / --server <ssh> to remove the server side too"
    for t in $targets; do
      [[ $t == local ]] && ! find_local_python && { warn "python3 not found on this Mac"; continue }
      uninstall_target $t
    done
    ;;
  install)
    step "Extension"
    register_extension
    step "Servers"
    note_servers
    [[ -f $SETUP_PY ]] || { (( ${#targets} )) && die "$SETUP_PY not found; update the checkout" }
    for t in $targets; do
      say "$t:"
      check_target $t && setup_target $t
    done
    if (( ${#bridge_host_of} )); then
      step "Open-file bridge"
      for t in ${(k)bridge_host_of}; do install_bridge $t; done
    fi
    [[ -f $OLD_AGENT ]] && notes+=("app.muxy.cmd-watch (old cmd-bridge) is not needed by claude-chat; keep it only if you use it for other things.")
    manual+=("On first use, allow and remember Muxy's prompts: running python3 (the chat's server CLI, twice: reader and agent host), opening a terminal tab (chat -> terminal).")
    ;;
esac

step "Summary"
if (( ${#done_items} )); then for x in $done_items; do say "${${dry:#0}:+would be }done: $x"; done
elif (( ! dry )); then say "nothing changed"; fi
for x in $manual; do say "${B}manual:${N} $x"; done
for x in $notes; do say "note: $x"; done
if [[ $mode == install ]]; then
  say "update: git pull, then Settings -> Extensions -> $ext_name -> Reload (re-run this script if host/ or server/ changed)"
  say "check:  ${(q-)SCRIPT} --check $target_flags"
  say "remove: ${(q-)SCRIPT} --uninstall $target_flags"
fi
if (( ${#problems} )); then
  print -r -- ""
  print -r -- "${Y}${#problems} warning(s):${N}"
  for x in $problems; do say "- $x"; done
fi
if (( ${#failures} )); then
  print -r -- ""
  print -r -- "${R}${#failures} error(s):${N}"
  for x in $failures; do say "- $x"; done
  exit 1
fi
exit 0

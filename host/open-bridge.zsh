#!/bin/zsh
# claude-chat open-file bridge. launchd (dev.claude-chat.open-bridge.<server>) runs it when <dir>/req changes, or,
# with --poll SECS (sshfs: launchd misses changes made on the server), keeps it running and it scans <dir>/req.
# A request <dir>/req/<id>.json {"id","path","line","app","root","ts"} names a server path under
# --server-root; it is mapped to --host-root, opened, and answered in <dir>/res/<id>.json. App "url" opens an
# http(s) link from "path" in the default browser.
emulate -R zsh
setopt no_unset pipe_fail extended_glob
zmodload zsh/datetime
zmodload -F zsh/stat b:zstat

dir= host_root= server_root=
log_file=$HOME/Library/Logs/claude-chat-open-bridge.log
linger=20
poll=
launch_err=
while (( $# )); do
  case $1 in
    --dir) dir=$2; shift ;;
    --host-root) host_root=$2; shift ;;
    --server-root) server_root=$2; shift ;;
    --log) log_file=$2; shift ;;
    --linger) linger=$2; shift ;;
    --poll) poll=$2; shift ;;
    *) print -u2 -r -- "open-bridge: unknown argument: $1"; exit 2 ;;
  esac
  shift
done
[[ -n $dir && -n $host_root && -n $server_root ]] || { print -u2 "usage: open-bridge.zsh --dir D --host-root H --server-root S"; exit 2 }
host_root=${host_root%/}
server_root=${server_root%/}

typeset -a size
if zstat -A size +size -- $log_file 2>/dev/null && (( size[1] > 1048576 )); then
  mv -f -- $log_file $log_file.1
fi

log() { print -r -- "$(strftime '%Y-%m-%d %H:%M:%S' $EPOCHSECONDS) $*" >>$log_file }

# Validates the request and prints id, app, line ("-" if none), root, path; one per line.
PARSE_JS='ObjC.import("Foundation");
function run(argv) {
  var s = $.NSString.stringWithContentsOfFileEncodingError(argv[0], $.NSUTF8StringEncoding, null);
  if (s.isNil()) throw new Error("unreadable request");
  var r = JSON.parse(ObjC.unwrap(s));
  if (!r || typeof r !== "object") throw new Error("request is not an object");
  function str(k, re) {
    var v = r[k];
    if (typeof v !== "string" || !v.length || /[\u0000-\u001f\u007f]/.test(v) || (re && !re.test(v))) throw new Error("bad " + k);
    return v;
  }
  var line = r.line;
  if (line === undefined || line === null || line === "") line = "-";
  else if (typeof line === "number" && line % 1 === 0 && line > 0 && line < 1e9) line = String(line);
  else throw new Error("bad line");
  return [str("id", /^[A-Za-z0-9._-]{1,128}$/), str("app", /^(zed|idea|finder|ping|fonts|url)$/), line, str("root"), str("path")].join("\n");
}'

RESULT_JS='function run(a) { var r = {ok: a[0] === "1"}; if (!r.ok) r.error = a[1] || "open failed"; return JSON.stringify(r); }'

respond() { # <id> <1|0> [error]
  local out tmp=$dir/res/.$1.tmp
  out=$(/usr/bin/osascript -l JavaScript -e "$RESULT_JS" "$2" "${3-}" 2>/dev/null) || out='{"ok":false,"error":"bridge could not encode the result"}'
  print -r -- "$out" >$tmp && mv -f -- $tmp $dir/res/$1.json
}

FONTS_JS='ObjC.import("AppKit");
function run() {
  var names = ObjC.deepUnwrap($.NSFontManager.sharedFontManager.availableFontFamilies).filter(function (n) { return n.charAt(0) !== "."; });
  names.sort(function (a, b) { return a.toLowerCase().localeCompare(b.toLowerCase()); });
  return JSON.stringify({ok: true, fonts: names});
}'

respond_fonts() { # <id>
  local out tmp=$dir/res/.$1.tmp
  out=$(/usr/bin/osascript -l JavaScript -e "$FONTS_JS" 2>/dev/null) || out='{"ok":false,"error":"could not list fonts"}'
  print -r -- "$out" >$tmp && mv -f -- $tmp $dir/res/$1.json
}

# Starts argv detached from our stdio; fails only if it exits non-zero within ~3 s.
launch() {
  local errf=$dir/res/.launch-$$.err pid i rc
  "$@" </dev/null >/dev/null 2>$errf &
  pid=$!
  for i in {1..15}; do
    if ! kill -0 $pid 2>/dev/null; then
      wait $pid; rc=$?
      launch_err=$(<$errf); rm -f -- $errf
      return $rc
    fi
    sleep 0.2
  done
  rm -f -- $errf
  launch_err=
  return 0
}

first_exe() {
  local c
  for c in "$@"; do [[ -n $c && -x $c && ! -d $c ]] && { print -r -- $c; return 0 }; done
  return 1
}

open_target() { # <app> <host path> <line or ->
  local app=$1 target=$2 line=$3 cli bundle
  launch_err=
  case $app in
    ping) return 0 ;;
    finder)
      launch /usr/bin/osascript -e 'on run argv' -e 'tell application "Finder"' \
        -e 'reveal (POSIX file (item 1 of argv) as alias)' -e 'activate' -e 'end tell' -e 'end run' $target
      ;;
    zed)
      if cli=$(first_exe "${commands[zed]-}" /Applications/Zed.app/Contents/MacOS/cli "$HOME/Applications/Zed.app/Contents/MacOS/cli"); then
        if [[ $line == - ]]; then launch $cli $target; else launch $cli "$target:$line"; fi
      else
        launch /usr/bin/open -a Zed $target
      fi
      ;;
    idea)
      if cli=$(first_exe "${commands[idea]-}" "$HOME/Library/Application Support/JetBrains/Toolbox/scripts/idea" /usr/local/bin/idea /opt/homebrew/bin/idea); then
        if [[ $line == - ]]; then launch $cli $target; else launch $cli --line $line $target; fi
        return
      fi
      for bundle in com.jetbrains.intellij com.jetbrains.intellij.ce; do
        launch /usr/bin/open -b $bundle $target && return 0
      done
      launch /usr/bin/open -a "IntelliJ IDEA" $target && return 0
      launch /usr/bin/open -a "IntelliJ IDEA CE" $target && return 0
      launch /usr/bin/open -a "IntelliJ IDEA Ultimate" $target
      ;;
    *) launch_err="unknown app: $app"; return 2 ;;
  esac
}

handle() { # <request file>
  local file=$1 id=${${1:t}%.json} out app line root spath rel target
  local -a f
  if [[ $id != [A-Za-z0-9._-]## ]]; then
    log "dropped request with bad name: ${(q+)file:t}"
    rm -f -- $file; return
  fi
  out=$(/usr/bin/osascript -l JavaScript -e "$PARSE_JS" $file 2>&1)
  if (( $? )); then
    rm -f -- $file
    log "$id: invalid request: ${out##*Error: }"
    respond $id 0 "invalid request"; return
  fi
  rm -f -- $file
  f=("${(@f)out}")
  if (( ${#f} != 5 )) || [[ ${f[1]} != $id ]]; then
    log "$id: malformed request"; respond $id 0 "invalid request"; return
  fi
  app=${f[2]} line=${f[3]} root=${f[4]%/} spath=${f[5]}
  if [[ $root != $server_root ]]; then
    log "$id: root $root is not $server_root"; respond $id 0 "the bridge serves $server_root, not $root"; return
  fi
  if [[ $app == fonts ]]; then
    respond_fonts $id; return
  fi
  if [[ $app == url ]]; then
    if [[ $spath != (#i)http(s|)://[^[:space:]]## ]]; then
      log "$id: rejected url ${(q+)spath}"; respond $id 0 "only http(s) links can be opened"; return
    fi
    if launch /usr/bin/open $spath; then
      log "$id: url $spath"; respond $id 1
    else
      log "$id: url $spath failed: $launch_err"; respond $id 0 "${launch_err:-could not open the link}"
    fi
    return
  fi
  if [[ $spath != $server_root && $spath != $server_root/* ]] || [[ "$spath/" == */../* || "$spath/" == */./* || $spath == *//* ]]; then
    log "$id: rejected path ${(q+)spath}"; respond $id 0 "only plain paths under $server_root can be opened"; return
  fi
  rel=${spath:${#server_root}}
  target=$host_root$rel
  if [[ ! -e $target ]]; then
    log "$id: not found on the Mac: $target"; respond $id 0 "not found on the Mac: $target"; return
  fi
  if open_target $app $target $line; then
    [[ $app == ping ]] || log "$id: $app $target${${line:#-}:+:$line}"
    respond $id 1
  else
    log "$id: $app $target failed: $launch_err"
    respond $id 0 "${launch_err:-could not open in $app}"
  fi
}

mkdir -p -- $dir/req $dir/res || { log "cannot create $dir/req and $dir/res"; exit 1 }
rm -f -- $dir/res/*.json(N.mm+10) $dir/res/.*(N.mm+10)

[[ -z $poll || $poll == <1-60> ]] || { print -u2 "open-bridge: --poll wants 1-60 seconds"; exit 2 }
[[ -n $poll ]] && log "polling $dir/req every ${poll}s"
deadline=$(( EPOCHSECONDS + linger ))
while :; do
  for stale in $dir/req/*.json(N.ms+60); do
    log "${stale:t}: dropped, older than 60 s"; rm -f -- $stale
  done
  reqs=($dir/req/*.json(N))
  for req in $reqs; do handle $req; done
  (( ${#reqs} )) && deadline=$(( EPOCHSECONDS + linger ))
  if [[ -n $poll ]]; then
    (( ${#reqs} )) && sleep 0.2 || sleep $poll
    continue
  fi
  (( EPOCHSECONDS >= deadline )) && break
  sleep 0.2
done

// What a Review pane can show: params to a source and back, and Claude's edits per turn from the chat's store.
CC.Review = (function () {
  const D = CC.reviewDiff;
  const EDIT_TOOLS = { Edit: true, MultiEdit: true, Write: true, NotebookEdit: true };
  const WORKTREE = { id: D.WORKTREE_ID, kind: "uncommitted", label: D.WORKTREE_LABEL };

  function relTo(root) {
    return function (path) {
      return root != null && path.indexOf(root + "/") === 0 ? path.slice(root.length + 1) : path;
    };
  }

  function turnSource(uuid, ts, text, files) {
    return { id: "turn:" + uuid, kind: "turn", label: "your edits in the turn \"" + CC.util.firstLine(text, 80) + "\"", turn: uuid, ts: ts, text: text, files: files };
  }

  function baseSource(base) {
    return { id: "base:" + (base || ""), kind: "base", label: "this branch's changes against " + base, base: base };
  }

  function commitSource(sha, short, subject) {
    return { id: "commit:" + sha, kind: "commit", label: "commit " + short + " (" + subject + ")", commit: sha, short: short, subject: subject };
  }

  function rangeSource(range) {
    return { id: "range:" + range, kind: "range", label: "the commit range " + range, range: range };
  }

  // params: {source, checkout, turn?, commit?, range?, base?}. source: "uncommitted", "branch", "turn", "commit", "range"; the last two may
  // also carry the value, as "commit:<sha>", "range:<a..b>". Unknown or missing means uncommitted.
  function fromParams(params) {
    const p = params || {};
    const raw = typeof p.source === "string" ? p.source : "";
    const at = raw.indexOf(":");
    const kind = at > 0 ? raw.slice(0, at) : raw;
    const value = at > 0 ? raw.slice(at + 1) : null;
    if (kind === "turn" || (raw === "" && p.turn != null)) {
      const uuid = value || p.turn;
      return uuid != null ? turnSource(uuid, null, "", null) : WORKTREE;
    }
    if (kind === "commit" && (value || p.commit)) {
      const sha = value || p.commit;
      return commitSource(sha, sha.slice(0, 8), "");
    }
    if (kind === "range" && (value || p.range)) {
      return rangeSource(value || p.range);
    }
    if (kind === "branch" || kind === "base") {
      return baseSource(value || p.base || null);
    }
    return WORKTREE;
  }

  function toParams(src) {
    const out = { source: src.kind === "base" ? "branch" : src.kind };
    ["turn", "commit", "range", "base"].forEach(function (k) {
      if (src[k] != null) {
        out[k] = src[k];
      }
    });
    return out;
  }

  // "Claude's edits in a turn" from the store: every user prompt followed by Edit / Write results with a patch.
  function turnsFromStore(store, root) {
    const turns = [];
    let cur = null;
    (store != null && store.items != null ? store.items : []).forEach(function (it) {
      if (it.k === "user" && it.agent == null) {
        cur = it.command ? null : { uuid: it.id, ts: it.ts, text: it.text, tools: [] };
        if (cur != null) {
          turns.push(cur);
        }
      } else if (cur != null && it.k === "tool") {
        cur.tools.push(it);
      }
    });
    const rel = relTo(root);
    return turns.map(function (t) {
      return { uuid: t.uuid, ts: t.ts, text: t.text, files: store.editedFiles(t.tools, rel) };
    }).filter(function (t) {
      return t.files.length > 0;
    });
  }

  function lastEditedPath(store) {
    const items = store != null && store.items != null ? store.items : [];
    for (let i = items.length - 1; i >= 0; i--) {
      const it = items[i];
      if (it.k === "tool" && it.agent == null && EDIT_TOOLS[it.name] === true && it.input != null && typeof it.input.file_path === "string") {
        return it.input.file_path;
      }
    }
    return null;
  }

  // Store turns first (live, newest first); transcript turns only for what the store does not hold (older history).
  function turnSources(store, reply) {
    const res = reply || {};
    const live = turnsFromStore(store, res.root || null).reverse();
    const out = live.map(function (t) {
      return turnSource(t.uuid, t.ts, t.text, t.files);
    });
    (res.turns || []).forEach(function (t) {
      const dup = live.some(function (l) {
        return l.uuid === t.uuid || (l.text === t.text && Math.abs(Date.parse(l.ts) - Date.parse(t.ts)) < 5000);
      });
      if (!dup) {
        out.push(turnSource(t.uuid, t.ts, t.text, null));
      }
    });
    return out;
  }

  // The checkout holding the conversation's last Edit / Write (longest path prefix wins).
  function editedWorktree(store, worktrees) {
    const path = lastEditedPath(store);
    let best = null;
    (worktrees || []).forEach(function (w) {
      if (path != null && path.indexOf(w.path + "/") === 0 && (best == null || w.path.length > best.length)) {
        best = w.path;
      }
    });
    return best;
  }

  return {
    WORKTREE: WORKTREE, fromParams: fromParams, toParams: toParams, turnSource: turnSource, baseSource: baseSource, commitSource: commitSource,
    rangeSource: rangeSource, turnsFromStore: turnsFromStore, turnSources: turnSources, editedWorktree: editedWorktree, relTo: relTo,
  };
})();

// Which projects belong to this server, and the small forms. projects.list() returns every server's projects without saying which.
CC.SidebarProjects = (function () {
  const el = CC.util.el;

  // No catalog and no Python to check a path with means no Muxy CLI, which every remote server has, so this is this computer: all but other servers' Homes
  // and what's in them.
  function outsideOtherHomes(projects) {
    const homes = projects.filter(function (p, i) {
      return i > 0 && p.name === "Home" && p.path;
    }).map(function (p) {
      return p.path.replace(/\/+$/, "") + "/";
    });
    return new Set(projects.filter(function (p, i) {
      return i === 0 || !homes.some(function (h) {
        return (String(p.path) + "/").indexOf(h) === 0;
      });
    }).map(function (p) {
      return String(p.id);
    }));
  }

  // The server's own catalog when the host can read it, else a path check (a Local path may also exist here through a mount, so it can be wrong).
  // Null: not known, show everything. Also when no path exists here, since a real server has at least its Home.
  async function mineIds(projects, chatless) {
    const host = CC.host.projects;
    if (host.ofServer != null) {
      try {
        const ids = await host.ofServer();
        if (Array.isArray(ids)) {
          return new Set(ids.map(String));
        }
      } catch (e) {
        console.warn("this server's project list not read", e && e.message);
      }
    }
    if (chatless === true) {
      return outsideOtherHomes(projects);
    }
    try {
      const checks = await Promise.all(projects.map(function (p) {
        return CC.Servers.focused().host.call("resolveDir", { path: p.path || "" });
      }));
      const found = projects.filter(function (p, i) {
        return p.path && checks[i].isDir === true;
      });
      return found.length > 0 ? new Set(found.map(function (p) {
        return String(p.id);
      })) : null;
    } catch (e) {
      console.warn("project paths not checked", e && e.message);
      return null;
    }
  }

  // Trimmed form values → host.projects.add arguments, or {error}.
  function addArgs(path, name, createIfMissing) {
    const p = String(path || "").trim();
    if (p === "") {
      return { error: "Enter the folder path." };
    }
    if (p.charAt(0) !== "/" && p.charAt(0) !== "~") {
      return { error: "Use an absolute path, starting with / or ~/." };
    }
    const opts = { createIfMissing: createIfMissing === true };
    const n = String(name || "").trim();
    if (n !== "") {
      opts.name = n;
    }
    return { path: p, opts: opts };
  }

  function field(label, control) {
    const wrap = el("label", "sb-field");
    wrap.appendChild(el("span", null, label));
    wrap.appendChild(control);
    return wrap;
  }

  function textInput(value, placeholder) {
    const i = el("input", "sb-input");
    i.value = value || "";
    i.placeholder = placeholder || "";
    i.spellcheck = false;
    i.autocapitalize = "off";
    return i;
  }

  // Enter in a field is the dialog's primary button. The kit's dialog focuses that button; a form wants its first field.
  function formBehaviour(body, first) {
    body.addEventListener("keydown", function (e) {
      if (e.key === "Enter" && e.target.tagName === "INPUT" && e.target.type !== "checkbox") {
        e.preventDefault();
        e.target.closest(".cc-dialog").querySelector(".cc-btn-primary").click();
      }
    });
    setTimeout(function () {
      first.focus();
      first.select();
    }, 0);
  }

  // Comes back with what was typed and the reason when adding fails. server: where it goes; the tab's has no name to say.
  async function addDialog(server) {
    const typed = { path: "", name: "", create: false };
    let problem = null;
    for (;;) {
      const body = el("div", "sb-form");
      const path = textInput(typed.path, "~/projects/name");
      const name = textInput(typed.name, "Optional");
      const create = el("input");
      create.type = "checkbox";
      create.checked = typed.create;
      const check = el("label", "sb-check");
      check.appendChild(create);
      check.appendChild(el("span", null, "Create the folder if it's missing"));
      body.appendChild(field(server.name ? "Folder on " + server.name : "Folder on this server", path));
      body.appendChild(field("Name", name));
      body.appendChild(check);
      if (problem != null) {
        body.appendChild(el("div", "sb-form-error", problem));
      }
      formBehaviour(body, path);
      const ok = await CC.ui.dialog({ title: "Add project", body: body, buttons: [{ label: "Cancel", value: null }, { label: "Add", primary: true, value: true }] });
      if (ok !== true) {
        return;
      }
      typed.path = path.value;
      typed.name = name.value;
      typed.create = create.checked;
      const args = addArgs(typed.path, typed.name, typed.create);
      problem = args.error || null;
      if (problem == null) {
        try {
          await CC.host.projects.add(args.path, args.opts, server.route);
          return;
        } catch (e) {
          problem = e && e.message ? e.message : String(e);
        }
      }
    }
  }

  async function renameDialog(title) {
    const name = textInput(title);
    const body = el("div", "sb-form");
    body.appendChild(name);
    formBehaviour(body, name);
    const ok = await CC.ui.dialog({ title: "Rename", body: body, buttons: [{ label: "Cancel", value: null }, { label: "Rename", primary: true, value: true }] });
    return ok === true ? name.value : null;
  }

  return { outsideOtherHomes: outsideOtherHomes, mineIds: mineIds, addArgs: addArgs, addDialog: addDialog, renameDialog: renameDialog };
})();

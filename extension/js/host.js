window.CC = window.CC || {};

CC.host = (function () {
  const memory = {};

  function parse(op, res) {
    if (res.exitCode !== 0) {
      const detail = (res.stderr || "").trim() || (res.stdout || "").trim() || "exit " + res.exitCode;
      throw new Error("reader " + op + " failed: " + detail.split("\n").pop());
    }
    return JSON.parse(res.stdout);
  }

  async function reader(op, payload) {
    const body = Object.assign({ op: op }, payload || {});
    return parse(op, await muxy.exec(["python3", "-c", CC.READER_SRC], { stdin: JSON.stringify(body), timeoutMs: 30000 }));
  }

  // V2 agent host ops (server/claude_chat/cli.py) through the embedded bootstrap.
  async function cli(op, payload) {
    const body = Object.assign({ op: op }, payload || {});
    return parse(op, await muxy.exec(["python3", "-c", CC.CLI_SRC], { stdin: JSON.stringify(body), timeoutMs: 40000 }));
  }

  // execAsync can be cancelled, so a kick does not have to wait for the long poll to time out.
  function readerJob(op, payload, src) {
    const source = src || CC.READER_SRC;
    if (typeof muxy.execAsync !== "function") {
      return { result: source === CC.CLI_SRC ? cli(op, payload) : reader(op, payload), cancel: function () {} };
    }
    const body = Object.assign({ op: op }, payload || {});
    const job = muxy.execAsync(["python3", "-c", source], { stdin: JSON.stringify(body), timeoutMs: 40000 });
    return {
      result: job.result.then(function (res) {
        return parse(op, res);
      }),
      cancel: function () {
        Promise.resolve(job.cancel()).catch(function () {});
      },
    };
  }

  async function storageGet(key) {
    try {
      const v = await muxy.storage.get(key);
      return v;
    } catch (e) {
      return memory[key] != null ? memory[key] : null;
    }
  }

  async function storageSet(key, value) {
    memory[key] = value;
    try {
      if (value == null) {
        await muxy.storage.delete(key);
      } else {
        await muxy.storage.set(key, value);
      }
    } catch (e) {
      console.warn("storage write failed", key, e && e.message);
    }
  }

  return {
    reader: reader,
    cli: cli,
    cliJob: function (op, payload) {
      return readerJob(op, payload, CC.CLI_SRC);
    },
    readerJob: readerJob,
    storageGet: storageGet,
    storageSet: storageSet,
    viewId: function () {
      return muxy.tabInstanceID || "default";
    },
  };
})();

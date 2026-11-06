// Writes the bundle's server package to the server, in pieces because a request is limited. See `install` in server/claude_chat/bootstrap.py.
CC.serverInstall = (function () {
  const PIECE_CHARS = 350 * 1024;
  const running = new Map();

  // Plain ASCII, so that cutting anywhere can't split a character.
  function asciiJson(value) {
    return JSON.stringify(value).replace(/[\u0080-￿]/g, function (c) {
      return "\\u" + ("000" + c.charCodeAt(0).toString(16)).slice(-4);
    });
  }

  async function send(request) {
    const pkg = CC.SERVER_PACKAGE;
    const text = asciiJson(pkg.files);
    const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
    for (let offset = 0; offset < text.length; offset += PIECE_CHARS) {
      await request({
        version: pkg.version,
        id: id,
        offset: offset,
        data: text.slice(offset, offset + PIECE_CHARS),
        last: offset + PIECE_CHARS >= text.length,
      });
    }
  }

  // Everything that finds the package missing on a server meanwhile waits for that server's one install.
  function run(request, server) {
    if (!running.has(server)) {
      running.set(server, send(request).finally(function () {
        running.delete(server);
      }));
    }
    return running.get(server);
  }

  return { run: run };
})();

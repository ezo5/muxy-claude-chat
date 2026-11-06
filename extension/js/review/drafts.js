// Comments and viewed marks of one checkout, in kv `review:<checkout hash>`. Every pane on that checkout holds its own copy; a write
// tells the others to read it again, so two panes on one checkout don't overwrite each other.
CC.ReviewDrafts = (function () {
  const MAX_VIEWED = 5000;

  function Drafts(root, server) {
    this.server = server;
    this.scope = "review:" + CC.reviewDiff.hash(root);
    this.comments = [];
    this.viewed = {};
  }

  Drafts.prototype.load = async function () {
    const res = await Promise.all([this.server.host.kv.get(this.scope, "comments"), this.server.host.kv.get(this.scope, "viewed")]);
    this.comments = Array.isArray(res[0]) ? res[0] : [];
    this.viewed = res[1] != null && typeof res[1] === "object" ? res[1] : {};
  };

  function warned(promise) {
    return promise.catch(function (e) {
      console.warn("review drafts not saved:", e && e.message);
    });
  }

  Drafts.prototype.announce = function () {
    CC.bus.emit("review:drafts", { scope: this.scope, from: this });
  };

  Drafts.prototype.saveComments = async function () {
    const write = this.comments.length > 0 ? this.server.host.kv.set(this.scope, "comments", this.comments) : this.server.host.kv.del(this.scope, "comments");
    await warned(write);
    this.announce();
  };

  Drafts.prototype.saveViewed = async function () {
    const keys = Object.keys(this.viewed);
    for (let i = 0; i < keys.length - MAX_VIEWED; i++) {
      delete this.viewed[keys[i]];
    }
    await warned(this.server.host.kv.set(this.scope, "viewed", this.viewed));
    this.announce();
  };

  Drafts.prototype.storedViewed = function (src, path) {
    return this.viewed[src + "\n" + path] || null;
  };

  Drafts.prototype.setViewed = function (src, path, sig) {
    const key = src + "\n" + path;
    if (sig != null) {
      this.viewed[key] = sig;
    } else {
      delete this.viewed[key];
    }
  };

  return Drafts;
})();

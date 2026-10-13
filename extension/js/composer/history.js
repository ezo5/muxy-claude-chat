window.CC = window.CC || {};

CC.Composer.use(function (composer) {
  let list = [];
  let index = -1;
  let stash = "";

  composer.setHistory = function (items) {
    list = items.slice();
    index = -1;
  };

  composer.on("submitted", function (entry) {
    if (entry.text.trim() === "") {
      return false;
    }
    list = [entry.text].concat(list.filter(function (t) {
      return t !== entry.text;
    })).slice(0, 500);
    index = -1;
    return false;
  });

  function onFirstLine() {
    const ta = composer.input;
    return ta.value.slice(0, ta.selectionStart).indexOf("\n") < 0 && ta.selectionStart === ta.selectionEnd;
  }

  function onLastLine() {
    const ta = composer.input;
    return ta.value.slice(ta.selectionEnd).indexOf("\n") < 0 && ta.selectionStart === ta.selectionEnd;
  }

  function show(i) {
    index = i;
    composer.setValue(i < 0 ? stash : list[i], false);
  }

  composer.on("keydown", function (e) {
    if (e.altKey || e.metaKey || e.ctrlKey || e.shiftKey) {
      return false;
    }
    if (e.key === "ArrowUp" && onFirstLine() && list.length > 0) {
      const browsing = index >= 0 && composer.value() === list[index];
      if (!browsing && composer.value().trim() !== "" && composer.input.selectionStart !== 0) {
        return false;
      }
      if (!browsing) {
        stash = composer.value();
        index = -1;
      }
      if (index < list.length - 1) {
        show(index + 1);
      }
      return true;
    }
    if (e.key === "ArrowDown" && onLastLine() && index >= 0 && composer.value() === list[index]) {
      show(index - 1);
      return true;
    }
    return false;
  });
});

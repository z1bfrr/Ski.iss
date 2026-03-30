// content/typer.js
// Utility: type text into a CodeMirror editor instance character by character.
// Used as a fallback if the inline func injection fails.

window.__skillrackTyper = function(code, delayMs = 12) {
  return new Promise((resolve, reject) => {
    const cmEl = document.querySelector('.CodeMirror');
    if (!cmEl || !cmEl.CodeMirror) {
      reject(new Error('CodeMirror not found'));
      return;
    }

    const cm = cmEl.CodeMirror;
    cm.focus();
    cm.setValue('');
    cm.setCursor({ line: 0, ch: 0 });

    const chars = [...code]; // Unicode-safe split
    let i = 0;

    function next() {
      if (i >= chars.length) { resolve(); return; }
      cm.replaceSelection(chars[i++]);
      setTimeout(next, delayMs);
    }
    next();
  });
};

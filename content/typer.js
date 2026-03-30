// content/typer.js
// Fallback utility: type text into an Ace editor character by character.
// Called if the inline func injection in worker.js cannot locate the editor instance.

window.__skillIssueTyper = function(code, delayMs = 12) {
  return new Promise((resolve, reject) => {
    const aceEl = document.querySelector('.ace_editor');
    if (!aceEl) {
      reject(new Error('Ace editor not found on this page.'));
      return;
    }

    // Attempt to get the Ace editor JS instance
    let ed = null;
    if (aceEl.env && aceEl.env.editor) ed = aceEl.env.editor;
    if (!ed && window.ace && aceEl.id) { try { ed = window.ace.edit(aceEl.id); } catch(e) {} }
    if (!ed && window.ace)             { try { ed = window.ace.edit(aceEl);    } catch(e) {} }
    if (!ed && window.editor && typeof window.editor.insert === 'function') ed = window.editor;

    if (!ed || typeof ed.getSession !== 'function') {
      reject(new Error('Could not get Ace editor instance.'));
      return;
    }

    // Clear existing content and type char by char
    try { ed.getSession().setValue(''); } catch(e) {}
    try { ed.clearSelection(); }         catch(e) {}
    try { ed.focus(); }                  catch(e) {}

    const chars = [...code]; // Unicode-safe split
    let i = 0;

    function next() {
      if (i >= chars.length) { resolve(); return; }
      try { ed.insert(chars[i]); } catch(e) {}
      i++;
      setTimeout(next, delayMs);
    }
    next();
  });
};

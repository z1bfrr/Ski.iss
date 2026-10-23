// content/typer.js
// Standalone utility for editor typing and instant filling

window.__skillIssueTyper = function(code, options = {}) {
  const mode = typeof options === 'string' ? options : (options.mode || 'instant');
  const delayMs = typeof options === 'number' ? options : (options.delayMs || 12);

  return new Promise((resolve, reject) => {
    // 1. Ace Editor
    const aceEl = document.querySelector('.ace_editor');
    if (aceEl) {
      let ed = null;
      if (aceEl.env && aceEl.env.editor) ed = aceEl.env.editor;
      if (!ed && window.ace && aceEl.id) { try { ed = window.ace.edit(aceEl.id); } catch(e) {} }
      if (!ed && window.ace)             { try { ed = window.ace.edit(aceEl);    } catch(e) {} }
      if (!ed && window.editor && typeof window.editor.setValue === 'function') ed = window.editor;

      if (ed && typeof ed.setValue === 'function') {
        if (mode === 'instant') {
          ed.setValue(code, -1);
          ed.clearSelection();
          resolve({ ok: true, method: 'ace-instant' });
          return;
        }

        const prevBehaviours = ed.getBehavioursEnabled ? ed.getBehavioursEnabled() : true;
        if (ed.setBehavioursEnabled) ed.setBehavioursEnabled(false);

        ed.setValue('', -1);
        ed.clearSelection();

        const chars = [...code];
        let i = 0;
        function next() {
          if (i >= chars.length) {
            if (ed.setBehavioursEnabled) ed.setBehavioursEnabled(prevBehaviours);
            resolve({ ok: true, method: 'ace-typed' });
            return;
          }
          try { ed.insert(chars[i]); } catch(e) {}
          i++;
          setTimeout(next, delayMs);
        }
        next();
        return;
      }
    }

    // 2. CodeMirror
    const cmEl = document.querySelector('.CodeMirror');
    if (cmEl && cmEl.CodeMirror) {
      cmEl.CodeMirror.setValue(code);
      resolve({ ok: true, method: 'codemirror' });
      return;
    }

    // 3. Fallback Textarea
    const ta = document.querySelector('textarea:not(.ace_text-input)');
    if (ta) {
      ta.value = code;
      ta.dispatchEvent(new Event('input', { bubbles: true }));
      ta.dispatchEvent(new Event('change', { bubbles: true }));
      resolve({ ok: true, method: 'textarea' });
      return;
    }

    reject(new Error('No compatible code editor found on the page.'));
  });
};

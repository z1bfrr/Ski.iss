// background/worker.js

let popupWindowId = null;

// Open popup window on icon click
chrome.action.onClicked.addListener(async (tab) => {
  if (popupWindowId !== null) {
    try {
      await chrome.windows.update(popupWindowId, { focused: true });
      return;
    } catch {
      popupWindowId = null;
    }
  }

  const win = await chrome.windows.create({
    url: chrome.runtime.getURL('popup/popup.html'),
    type: 'popup',
    width: 420,
    height: 620,
    focused: true
  });
  popupWindowId = win.id;

  // Store the active tab id so popup knows which tab to act on
  await chrome.storage.session.set({ activeTabId: tab.id });
});

// Clean up when popup window is closed
chrome.windows.onRemoved.addListener((windowId) => {
  if (windowId === popupWindowId) popupWindowId = null;
});

// Central message router
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  switch (message.type) {

    case 'SCRAPE_PROBLEM': {
      handleScrape(sendResponse);
      return true; // async
    }

    case 'GENERATE_CODE': {
      handleGenerate(message.payload, sendResponse);
      return true; // async
    }

    case 'TYPE_CODE': {
      handleType(message.payload, sendResponse);
      return true; // async
    }

    case 'RUN_CODE': {
      handleRunAndSubmit(message.payload, sendResponse);
      return true; // async
    }

    case 'GET_SETTINGS': {
      chrome.storage.local.get(['groqKey', 'typingSpeed', 'language'], sendResponse);
      return true;
    }

    case 'SAVE_SETTINGS': {
      chrome.storage.local.set(message.payload, () => sendResponse({ ok: true }));
      return true;
    }
  }
});

// --- FIND SKILLRACK TAB ---
async function findSkillRackTabId() {
  // First: look for any open SkillRack tab
  const tabs = await chrome.tabs.query({
    url: ['https://www.skillrack.com/*', 'https://skillrack.com/*']
  });
  if (tabs.length > 0) {
    // Prefer the one with 'codeprogram' in URL (actual problem page)
    const problemTab = tabs.find(t => t.url && t.url.includes('codeprogram'));
    return (problemTab || tabs[0]).id;
  }
  // Fallback: stored tab ID
  const { activeTabId } = await chrome.storage.session.get('activeTabId');
  return activeTabId || null;
}

// --- SCRAPE ---
async function handleScrape(sendResponse) {
  const activeTabId = await findSkillRackTabId();
  if (!activeTabId) {
    sendResponse({ error: 'No SkillRack tab found. Open a problem page at skillrack.com first.' });
    return;
  }

  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId: activeTabId },
      files: ['content/scraper.js']
    });
    const problem = results[0]?.result;
    if (!problem || !problem.title) {
      sendResponse({ error: 'Could not find a problem on this page. Navigate to a SkillRack problem.' });
    } else {
      sendResponse({ ok: true, problem });
    }
  } catch (err) {
    sendResponse({ error: `Scrape failed: ${err.message}` });
  }
}

// --- GENERATE (Groq / Llama 3.3 - 100% FREE) ---
async function handleGenerate({ problem, language }, sendResponse) {
  const { groqKey } = await chrome.storage.local.get('groqKey');
  if (!groqKey) {
    sendResponse({ error: 'No Groq API key. Click ⚙ Settings → paste your free key from console.groq.com' });
    return;
  }

  const systemPrompt = `You are an expert competitive programmer.
Return ONLY the complete, compilable ${language} source code that solves the problem.
No explanations. No markdown fences. No extra comments.
The code must read from stdin and write to stdout.
Output ONLY the raw source code.`;

  const userPrompt = `Problem Title: ${problem.title}

Problem Statement:
${problem.statement}

${problem.sampleInput  ? `Sample Input:\n${problem.sampleInput}\n`  : ''}${problem.sampleOutput ? `Sample Output:\n${problem.sampleOutput}\n` : ''}Language: ${language}
Write the complete solution now.`;

  try {
    const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${groqKey}`
      },
      body: JSON.stringify({
        model: 'llama-3.3-70b-versatile',
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user',   content: userPrompt }
        ],
        temperature: 0.2,
        max_tokens: 2048
      })
    });

    if (!response.ok) {
      const err = await response.json().catch(() => ({}));
      sendResponse({ error: `Groq error: ${err.error?.message || response.statusText}` });
      return;
    }

    const data = await response.json();
    let code = data.choices?.[0]?.message?.content?.trim();
    if (!code) {
      sendResponse({ error: 'Groq returned empty response. Try again.' });
      return;
    }

    // Strip markdown fences if model adds them
    code = code.replace(/^```[\w]*\n?/m, '').replace(/```\s*$/m, '').trim();

    sendResponse({ ok: true, code });
  } catch (err) {
    sendResponse({ error: `API call failed: ${err.message}` });
  }
}

// --- TYPE ---
async function handleType({ code, typingSpeed }, sendResponse) {
  const activeTabId = await findSkillRackTabId();
  if (!activeTabId) {
    sendResponse({ error: 'No SkillRack tab found. Open a problem page first.' });
    return;
  }

  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId: activeTabId, allFrames: true },
      func: initTyper,
      args: [code, typingSpeed || 12],
      world: 'MAIN'   // ← CRITICAL: runs in page's JS context, not isolated sandbox
                      //   Without this, window.ace / window.editor are undefined
    });
    const success = results.some(r => r?.result?.ok);
    const firstError = results.find(r => r?.result?.error)?.result?.error;
    if (!success && firstError) {
      sendResponse({ error: firstError });
    } else {
      sendResponse({ ok: true });
    }
  } catch (err) {
    sendResponse({ error: `Typing failed: ${err.message}` });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// initTyper — runs INSIDE the page/iframe context via executeScript
// With allFrames:true this runs in every frame. The frame that has the editor
// will find it and type; other frames will silently return ok:false.
// ─────────────────────────────────────────────────────────────────────────────
function initTyper(code, delayMs) {
  return new Promise((resolve) => {

    const aceEl = document.querySelector('.ace_editor');
    if (!aceEl) { resolve({ ok: false, skipped: true }); return; }

    // ── Path 1: Try to get the Ace JS instance and use setValue ──────
    let ed = null;
    if (aceEl.env && aceEl.env.editor) ed = aceEl.env.editor;
    if (!ed && window.ace && aceEl.id) { try { ed = window.ace.edit(aceEl.id); } catch(e) {} }
    if (!ed && window.ace)             { try { ed = window.ace.edit(aceEl);    } catch(e) {} }
    if (!ed && window.editor && typeof window.editor.insert === 'function') ed = window.editor;

    if (ed && typeof ed.getSession === 'function') {
      // We have the API — clear template and type char by char
      try { ed.getSession().setValue(''); } catch(e) {}
      try { ed.clearSelection(); }         catch(e) {}
      try { ed.focus(); }                  catch(e) {}

      const chars = [...code];
      let i = 0;
      function typeNext() {
        if (i >= chars.length) { resolve({ ok: true }); return; }
        try { ed.insert(chars[i]); } catch(e) {}
        i++;
        setTimeout(typeNext, delayMs);
      }
      typeNext();
      return;
    }

    // ── Path 2: Paste via synthetic ClipboardEvent on Ace's textarea ─
    // Ace registers a paste listener on its hidden textarea.
    // Sending a ClipboardEvent with our code as text/plain data works
    // without needing the JS editor instance at all.
    const textarea = aceEl.querySelector('textarea.ace_text-input');
    if (!textarea) { resolve({ ok: false, error: 'Ace textarea not found.' }); return; }

    // Focus the editor first
    aceEl.click();
    textarea.focus();

    // Select-all so paste replaces the existing default template
    textarea.dispatchEvent(new KeyboardEvent('keydown', {
      key: 'a', code: 'KeyA', ctrlKey: true, bubbles: true, cancelable: true
    }));

    setTimeout(() => {
      // Build a DataTransfer object carrying our code
      const dt = new DataTransfer();
      dt.setData('text/plain', code);

      // Dispatch paste event — Ace's onPaste handler will read clipboardData
      const pasteEvt = new ClipboardEvent('paste', {
        bubbles: true, cancelable: true, clipboardData: dt
      });
      textarea.dispatchEvent(pasteEvt);

      // Short wait then also try execCommand as a safety net
      setTimeout(() => {
        // If paste event didn't insert (some Ace versions ignore synthetic events),
        // fall back to execCommand insertText on the focused element
        const val = ed ? ed.getValue() : '';
        if (!val || val.trim() === '') {
          try {
            document.execCommand('selectAll', false, null);
            document.execCommand('insertText', false, code);
          } catch(e) {}
        }
        resolve({ ok: true });
      }, 300);
    }, 150);
  });
}




// --- RUN & SUBMIT ---
async function handleRunAndSubmit({ autoNext }, sendResponse) {
  const activeTabId = await findSkillRackTabId();
  if (!activeTabId) {
    sendResponse({ error: 'No SkillRack tab found.' });
    return;
  }

  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId: activeTabId },
      func: clickRunAndSubmit,
      args: [autoNext || false]
    });
    const result = results[0]?.result;
    if (result && result.error) {
      sendResponse({ error: result.error });
    } else {
      sendResponse({ ok: true, output: result?.output });
    }
  } catch (err) {
    sendResponse({ error: `Run failed: ${err.message}` });
  }
}

// This function runs IN the page context
function clickRunAndSubmit(autoNext) {
  return new Promise((resolve) => {

    // Helper: find a button by its visible text
    const findBtn = (labels) => {
      const allBtns = [...document.querySelectorAll('button, input[type="button"], input[type="submit"], a.button, a.btn')];
      return allBtns.find(b => {
        const txt = (b.textContent || b.value || b.innerText || '').trim().toLowerCase();
        return labels.some(l => txt === l || txt.includes(l));
      });
    };

    // 1. Click the Run button
    const runBtn = findBtn(['run', 'run code', 'execute', 'compile']);
    if (!runBtn) {
      resolve({ error: 'Run button not found on the page.' });
      return;
    }
    runBtn.click();

    // 2. Wait for output to appear (poll every 500ms, up to 20s)
    let waited = 0;
    const maxWait = 20000;
    const interval = 500;

    const poll = setInterval(() => {
      waited += interval;

      // SkillRack output containers
      const outputSels = [
        '#output', '.output', '[id*="output"]', '[class*="output"]',
        '#result', '.result', '[id*="result"]', 'pre.code', '.console'
      ];
      let outputText = '';
      for (const sel of outputSels) {
        const el = document.querySelector(sel);
        if (el && el.innerText.trim().length > 0) {
          outputText = el.innerText.trim();
          break;
        }
      }

      if (outputText || waited >= maxWait) {
        clearInterval(poll);

        if (!outputText && waited >= maxWait) {
          resolve({ error: 'Timed out waiting for output. Check if Run worked.' });
          return;
        }

        // 3. Click Submit button after a short delay
        setTimeout(() => {
          const submitBtn = findBtn(['submit', 'process', 'evaluate', 'save & submit', 'mark as solved']);
          if (submitBtn) {
            submitBtn.click();

            // 4. Optionally click Next after submit
            if (autoNext) {
              setTimeout(() => {
                const nextBtn = findBtn(['next', 'next problem', 'next question', 'continue']);
                if (nextBtn) nextBtn.click();
                resolve({ ok: true, output: outputText, submitted: true, next: !!nextBtn });
              }, 1500);
            } else {
              resolve({ ok: true, output: outputText, submitted: true, next: false });
            }
          } else {
            // No submit button found — just return output
            resolve({ ok: true, output: outputText, submitted: false, next: false });
          }
        }, 800);
      }
    }, interval);
  });
}

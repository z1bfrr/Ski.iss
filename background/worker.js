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
    width: 440,
    height: 660,
    focused: true
  });
  popupWindowId = win.id;
  await chrome.storage.session.set({ activeTabId: tab.id });
});

chrome.windows.onRemoved.addListener((id) => {
  if (id === popupWindowId) popupWindowId = null;
});

// Central message router
chrome.runtime.onMessage.addListener((msg, _, sendResponse) => {
  (async () => {
    try {
      const tabId = await findSkillRackTabId();

      switch (msg.type) {
        case 'SCRAPE_PROBLEM': {
          if (!tabId) throw new Error('No SkillRack tab found. Open skillrack.com first.');
          const problem = await scrapeTab(tabId);
          sendResponse({ ok: true, problem });
          break;
        }

        case 'GENERATE_CODE': {
          const { problem, language, modelName } = msg.payload;
          const code = await generateSolution(problem, language, modelName);
          sendResponse({ ok: true, code });
          break;
        }

        case 'TYPE_CODE': {
          if (!tabId) throw new Error('No SkillRack tab found.');
          await fillEditor(tabId, msg.payload.code, msg.payload);
          sendResponse({ ok: true });
          break;
        }

        case 'AUTO_SOLVE_AND_FILL': {
          if (!tabId) throw new Error('No SkillRack tab found. Open a problem first.');
          const problem = await scrapeTab(tabId);
          const lang = msg.payload.language || problem.detectedLanguage || 'Python 3';
          const code = await generateSolution(problem, lang, msg.payload.modelName);
          await fillEditor(tabId, code, msg.payload);

          let runOutput = null;
          if (msg.payload.autoRun) {
            const runRes = await runAndSubmit(tabId, msg.payload.autoNext);
            runOutput = runRes?.output;
          }
          sendResponse({ ok: true, problem, code, language: lang, runOutput });
          break;
        }

        case 'RUN_CODE': {
          if (!tabId) throw new Error('No SkillRack tab found.');
          const result = await runAndSubmit(tabId, msg.payload.autoNext);
          sendResponse({ ok: true, ...result });
          break;
        }

        case 'FETCH_MODELS': {
          const { groqKey } = await chrome.storage.local.get('groqKey');
          const key = msg.payload?.groqKey || groqKey;
          if (!key) throw new Error('Enter Groq API key first.');
          const res = await fetch('https://api.groq.com/openai/v1/models', {
            headers: { Authorization: `Bearer ${key}` }
          });
          if (!res.ok) throw new Error(`Groq auth error (${res.status})`);
          const data = await res.json();
          const models = (data.data || [])
            .map(m => m.id)
            .filter(id => !id.includes('whisper') && !id.includes('guard') && !id.includes('tts'))
            .sort();
          sendResponse({ ok: true, models });
          break;
        }

        case 'GET_SETTINGS': {
          const s = await chrome.storage.local.get(['groqKey', 'typingSpeed', 'language', 'fillMode', 'modelName']);
          sendResponse(s);
          break;
        }

        case 'SAVE_SETTINGS': {
          await chrome.storage.local.set(msg.payload);
          sendResponse({ ok: true });
          break;
        }
      }
    } catch (err) {
      sendResponse({ error: err.message });
    }
  })();
  return true; // async
});

// --- TAB FINDER ---
async function findSkillRackTabId() {
  const tabs = await chrome.tabs.query({ url: ['https://www.skillrack.com/*', 'https://skillrack.com/*'] });
  if (tabs.length > 0) {
    const pTab = tabs.find(t => t.url && /codeprogram|solve|test/i.test(t.url));
    return (pTab || tabs[0]).id;
  }
  const { activeTabId } = await chrome.storage.session.get('activeTabId');
  return activeTabId || null;
}

// --- CORE ASYNC OPS ---
async function scrapeTab(tabId) {
  const results = await chrome.scripting.executeScript({ target: { tabId }, files: ['content/scraper.js'] });
  const p = results[0]?.result;
  if (!p || (!p.title && !p.statement)) throw new Error('No problem content detected on this page.');
  return p;
}

async function generateSolution(problem, language, userModel) {
  const { groqKey, modelName } = await chrome.storage.local.get(['groqKey', 'modelName']);
  if (!groqKey) throw new Error('No Groq API key set. Open ⚙ Settings and add your key.');

  const model = userModel || modelName || 'llama-3.3-70b-versatile';

  // Compact prompt to minimize token burn
  const system = `Competitive programmer. Return ONLY raw compilable ${language} code solving the task.
No markdown fences, no comments, no explanation. Stdin->Stdout.
Java: class Hello. C/C++: standard headers, long long for >10^9. Python: sys.stdin.read().split().`;

  let prompt = `${problem.title ? `Title: ${problem.title}\n` : ''}${problem.statement || ''}\n`;
  if (problem.constraints) prompt += `Limits: ${problem.constraints}\n`;
  if (problem.inputFormat) prompt += `InFormat: ${problem.inputFormat}\n`;
  if (problem.outputFormat) prompt += `OutFormat: ${problem.outputFormat}\n`;

  // Include at most 2 sample cases to conserve token budget
  if (problem.examples?.length) {
    problem.examples.slice(0, 2).forEach((e, i) => {
      prompt += `Ex${i + 1}:\nIn:${e.input}\nOut:${e.output}\n`;
    });
  } else if (problem.sampleInput || problem.sampleOutput) {
    prompt += `Sample:\nIn:${problem.sampleInput || ''}\nOut:${problem.sampleOutput || ''}\n`;
  }
  prompt += `Language: ${language}. Code:`;

  const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${groqKey}` },
    body: JSON.stringify({
      model,
      messages: [{ role: 'system', content: system }, { role: 'user', content: prompt }],
      temperature: 0.1,
      max_tokens: 1500
    })
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error?.message || `HTTP ${res.status} calling ${model}`);
  }

  const data = await res.json();
  const code = data.choices?.[0]?.message?.content?.trim();
  if (!code) throw new Error('Model returned an empty response.');
  return code.replace(/^```[a-zA-Z0-9_+\-]*\n?/, '').replace(/```\s*$/, '').trim();
}

async function fillEditor(tabId, code, options) {
  const results = await chrome.scripting.executeScript({
    target: { tabId, allFrames: true },
    func: initEditorFiller,
    args: [code, { mode: options?.fillMode || 'instant', delayMs: options?.typingSpeed || 12 }],
    world: 'MAIN'
  });
  const ok = results.some(r => r?.result?.ok);
  if (!ok) {
    const err = results.find(r => r?.result?.error)?.result?.error;
    throw new Error(err || 'No compatible code editor found.');
  }
}

async function runAndSubmit(tabId, autoNext) {
  const results = await chrome.scripting.executeScript({
    target: { tabId, allFrames: true },
    func: clickRunSubmit,
    args: [autoNext || false],
    world: 'MAIN'
  });
  const r = results.find(x => x?.result?.ok)?.result;
  if (!r) throw new Error('Run button not found on page.');
  return r;
}

// ── Injected in target page (MAIN world) ──
function initEditorFiller(code, opt) {
  return new Promise((resolve) => {
    const mode = opt?.mode || 'instant';
    const delay = opt?.delayMs || 12;

    const syncInputs = () => {
      document.querySelectorAll('textarea, input[type="hidden"], input[type="text"]').forEach(el => {
        const n = `${el.id} ${el.name}`.toLowerCase();
        if (n.includes('code') || n.includes('source') || n.includes('program') || n.includes('editor')) {
          el.value = code;
          el.dispatchEvent(new Event('input', { bubbles: true }));
          el.dispatchEvent(new Event('change', { bubbles: true }));
        }
      });
    };

    // 1. Ace Editor
    const aceEl = document.querySelector('.ace_editor');
    if (aceEl) {
      let ed = aceEl.env?.editor || (window.ace && (window.ace.edit(aceEl.id || aceEl))) || window.editor;
      if (ed?.setValue) {
        if (mode === 'instant' || delay <= 1) {
          ed.setValue(code, -1);
          ed.clearSelection();
          syncInputs();
          resolve({ ok: true, method: 'ace-instant' });
          return;
        }
        // Typing mode: temporarily disable auto-brackets so Ace won't inject duplicate quotes/braces
        const prevB = ed.getBehavioursEnabled ? ed.getBehavioursEnabled() : true;
        if (ed.setBehavioursEnabled) ed.setBehavioursEnabled(false);
        ed.setValue('', -1);

        const chars = [...code];
        let i = 0;
        const typeChar = () => {
          if (i >= chars.length) {
            if (ed.setBehavioursEnabled) ed.setBehavioursEnabled(prevB);
            ed.clearSelection();
            syncInputs();
            resolve({ ok: true, method: 'ace-type' });
            return;
          }
          try { ed.insert(chars[i++]); } catch {}
          setTimeout(typeChar, Math.max(3, delay + Math.floor(Math.random() * 6 - 3)));
        };
        typeChar();
        return;
      }
    }

    // 2. CodeMirror
    const cm = document.querySelector('.CodeMirror')?.CodeMirror;
    if (cm?.setValue) {
      cm.setValue(code);
      syncInputs();
      resolve({ ok: true, method: 'codemirror' });
      return;
    }

    // 3. Fallback textarea
    const ta = document.querySelector('textarea:not(.ace_text-input)');
    if (ta) {
      ta.value = code;
      ta.dispatchEvent(new Event('input', { bubbles: true }));
      ta.dispatchEvent(new Event('change', { bubbles: true }));
      syncInputs();
      resolve({ ok: true, method: 'textarea' });
      return;
    }

    resolve({ ok: false });
  });
}

function clickRunSubmit(autoNext) {
  return new Promise((resolve) => {
    const findBtn = (keys) => {
      return [...document.querySelectorAll('button, input[type="button"], input[type="submit"], a.button, a.btn, span.ui-button-text')]
        .find(b => keys.some(k => (b.textContent || b.value || '').trim().toLowerCase().includes(k)));
    };

    const run = findBtn(['run', 'compile', 'execute']);
    if (!run) return resolve({ ok: false });
    (run.closest('button, a, input') || run).click();

    let waited = 0;
    const poll = setInterval(() => {
      waited += 500;
      const outEl = document.querySelector('#output, .output, #result, .result, pre.code, .console, .ui-terminal-content');
      const out = outEl?.innerText?.trim() || '';

      if (out || waited >= 20000) {
        clearInterval(poll);
        setTimeout(() => {
          const sub = findBtn(['submit', 'process', 'evaluate']);
          if (sub) (sub.closest('button, a, input') || sub).click();
          if (autoNext) {
            setTimeout(() => {
              const nxt = findBtn(['next', 'continue']);
              if (nxt) (nxt.closest('button, a, input') || nxt).click();
              resolve({ ok: true, output: out, submitted: !!sub, next: !!nxt });
            }, 1200);
          } else {
            resolve({ ok: true, output: out, submitted: !!sub });
          }
        }, 700);
      }
    }, 500);
  });
}

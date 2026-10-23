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
    height: 700,
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
          const { problem, language, modelName, errorFeedback } = msg.payload;
          const code = await generateSolution(problem, language, modelName, errorFeedback);
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

          let runRes = null;
          if (msg.payload.autoRun) {
            await new Promise(r => setTimeout(r, 600));
            runRes = await runAndSubmit(tabId, {
              autoNext: msg.payload.autoNext,
              skipIfFailed: msg.payload.skipOnFail
            });
          }
          sendResponse({ ok: true, problem, code, language: lang, runOutput: runRes?.output, passed: runRes?.passed });
          break;
        }

        case 'AUTO_PILOT_STEP': {
          if (!tabId) throw new Error('No SkillRack tab found.');
          const problem = await scrapeTab(tabId);
          const lang = msg.payload.language || problem.detectedLanguage || 'Python 3';

          // Step 1: Generate initial optimal solution
          let code = await generateSolution(problem, lang, msg.payload.modelName);
          await fillEditor(tabId, code, msg.payload);
          await new Promise(r => setTimeout(r, 600));

          // Step 2: Run & Evaluate test cases
          let runRes = await runAndSubmit(tabId, { autoNext: false, skipIfFailed: false });

          // Step 3: Self-Correction (Retry once if failed to achieve maximum score)
          if (!runRes.passed && runRes.output) {
            try {
              code = await generateSolution(problem, lang, msg.payload.modelName, runRes.output);
              await fillEditor(tabId, code, msg.payload);
              await new Promise(r => setTimeout(r, 600));
              runRes = await runAndSubmit(tabId, { autoNext: false, skipIfFailed: false });
            } catch (e) {
              console.warn('Self-correction attempt failed:', e);
            }
          }

          // Step 4: Submit & Advance, or Skip to Next Problem if unsolvable
          if (runRes.passed) {
            await submitAndNext(tabId, true);
            sendResponse({ ok: true, status: 'passed', problemTitle: problem.title, output: runRes.output });
          } else {
            // Cannot solve: go ahead to next problem to keep racking points
            await triggerNext(tabId);
            sendResponse({ ok: true, status: 'skipped', problemTitle: problem.title, output: runRes.output, reason: 'Failed test cases' });
          }
          break;
        }

        case 'RUN_CODE': {
          if (!tabId) throw new Error('No SkillRack tab found.');
          const result = await runAndSubmit(tabId, msg.payload);
          sendResponse({ ok: true, ...result });
          break;
        }

        case 'FETCH_MODELS': {
          const { groqKey } = await chrome.storage.local.get('groqKey');
          const key = (msg.payload?.groqKey || groqKey || '').trim().replace(/^["']|["']$/g, '');
          if (!key) throw new Error('Enter Groq API key first.');
          const res = await fetch('https://api.groq.com/openai/v1/models', {
            headers: { Authorization: `Bearer ${key}` }
          });
          if (res.status === 401) throw new Error('Invalid Groq key! Check console.groq.com/keys');
          if (!res.ok) throw new Error(`Groq error (HTTP ${res.status})`);
          const data = await res.json();
          const models = (data.data || [])
            .map(m => m.id)
            .filter(id => !id.includes('whisper') && !id.includes('guard') && !id.includes('tts') && !id.includes('embed') && !id.includes('safeguard'))
            .sort();
          sendResponse({ ok: true, models });
          break;
        }

        case 'GET_SETTINGS': {
          const s = await chrome.storage.local.get(['groqKey', 'typingSpeed', 'language', 'fillMode', 'modelName', 'skipOnFail']);
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

async function generateSolution(problem, language, userModel, errorFeedback = null) {
  let { groqKey, modelName } = await chrome.storage.local.get(['groqKey', 'modelName']);
  if (!groqKey) throw new Error('No Groq API key set. Open ⚙ Settings and add your key.');

  const apiKey = groqKey.trim().replace(/^["']|["']$/g, '');

  let modelCandidates = [];
  try {
    const mRes = await fetch('https://api.groq.com/openai/v1/models', {
      headers: { Authorization: `Bearer ${apiKey}` }
    });
    if (mRes.status === 401) {
      throw new Error('Invalid Groq API Key! Please get a new free key from console.groq.com/keys');
    }
    if (mRes.ok) {
      const mData = await mRes.json();
      const live = (mData.data || [])
        .map(m => m.id)
        .filter(id => !id.includes('whisper') && !id.includes('guard') && !id.includes('tts') && !id.includes('embed') && !id.includes('safeguard'));

      const requested = userModel || modelName;
      if (requested && live.includes(requested)) {
        modelCandidates.push(requested);
      }

      const priority = [
        'llama-3.3-70b-versatile',
        'openai/gpt-oss-120b',
        'openai/gpt-oss-20b',
        'qwen/qwen3.8-27b',
        'llama3-70b-8192',
        'llama3-8b-8192',
        'gemma2-9b-it',
        'mixtral-8x7b-32768'
      ];
      for (const p of priority) {
        if (live.includes(p) && !modelCandidates.includes(p)) modelCandidates.push(p);
      }
      for (const m of live) {
        if (!modelCandidates.includes(m)) modelCandidates.push(m);
      }
    }
  } catch (e) {
    if (e.message.includes('Invalid Groq API Key')) throw e;
  }

  if (modelCandidates.length === 0) {
    modelCandidates = [
      userModel || modelName || 'llama-3.3-70b-versatile',
      'openai/gpt-oss-120b',
      'openai/gpt-oss-20b',
      'llama3-70b-8192',
      'llama3-8b-8192',
      'gemma2-9b-it'
    ];
  }

  const system = `Competitive programming expert. Return ONLY raw, compilable ${language} code solving the problem for 100% score.
No markdown backticks, no comments, no explanation.
Language specific requirements:
- Java: public class Hello with public static void main.
- C/C++: include standard libraries (<stdio.h>, <stdlib.h>, <string.h>, <math.h> / <iostream>, <vector>, <string>, <algorithm>), use long long for numbers > 10^9.
- Python 3: handle fast I/O via sys.stdin.read().split() and EOF safely.
- SQL: ONLY executable standard SQL query ending with semicolon. Handle NULL values, proper JOIN types, GROUP BY, and column alias matching.`;

  let prompt = `${problem.title ? `Title: ${problem.title}\n` : ''}${problem.statement || ''}\n`;
  if (problem.constraints) prompt += `Limits: ${problem.constraints}\n`;
  if (problem.inputFormat) prompt += `InFormat: ${problem.inputFormat}\n`;
  if (problem.outputFormat) prompt += `OutFormat: ${problem.outputFormat}\n`;

  if (problem.examples?.length) {
    problem.examples.slice(0, 2).forEach((e, i) => {
      prompt += `Ex${i + 1}:\nIn:${e.input}\nOut:${e.output}\n`;
    });
  } else if (problem.sampleInput || problem.sampleOutput) {
    prompt += `Sample:\nIn:${problem.sampleInput || ''}\nOut:${problem.sampleOutput || ''}\n`;
  }

  if (errorFeedback) {
    prompt += `\nNOTE: Previous submission failed with output/error:\n${errorFeedback.slice(0, 400)}\nFix all edge cases and produce 100% working code:`;
  } else {
    prompt += `Language: ${language}. Code:`;
  }

  let lastError = null;
  for (const m of modelCandidates) {
    try {
      const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({
          model: m,
          messages: [{ role: 'system', content: system }, { role: 'user', content: prompt }],
          temperature: 0.1,
          max_tokens: 1500
        })
      });

      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error?.message || `HTTP ${res.status}`);
      }

      const data = await res.json();
      const code = data.choices?.[0]?.message?.content?.trim();
      if (!code) throw new Error('Empty response');

      await chrome.storage.local.set({ modelName: m });
      return code.replace(/^```[a-zA-Z0-9_+\-]*\n?/, '').replace(/```\s*$/, '').trim();
    } catch (e) {
      lastError = e;
      if (e.message.includes('does not exist') || e.message.includes('access') || e.message.includes('404')) {
        continue;
      }
      if (e.message.includes('Invalid') || e.message.includes('quota') || e.message.includes('rate_limit')) {
        throw e;
      }
    }
  }

  throw lastError || new Error('No working Groq model available for this key.');
}

async function fillEditor(tabId, code, options) {
  const results = await chrome.scripting.executeScript({
    target: { tabId, allFrames: true },
    func: initEditorFiller,
    args: [code, { mode: options?.fillMode || 'typing', delayMs: options?.typingSpeed || 6 }],
    world: 'MAIN'
  });

  const filled = results.find(r => r?.result?.ok && !r?.result?.skipped);
  if (!filled) {
    throw new Error('Could not find the SkillRack Ace editor on the page or in iframes.');
  }
}

async function runAndSubmit(tabId, options) {
  const results = await chrome.scripting.executeScript({
    target: { tabId, allFrames: true },
    func: clickRunSubmit,
    args: [options || {}],
    world: 'MAIN'
  });
  const r = results.find(x => x?.result?.ok)?.result;
  if (!r) throw new Error('Run button not found on page.');
  return r;
}

async function submitAndNext(tabId, doNext = true) {
  await chrome.scripting.executeScript({
    target: { tabId, allFrames: true },
    func: (autoNext) => {
      const findBtn = (keys) => {
        return [...document.querySelectorAll('button, input[type="button"], input[type="submit"], a.button, a.btn, span.ui-button-text')]
          .find(b => keys.some(k => (b.textContent || b.value || '').trim().toLowerCase().includes(k)));
      };
      const sub = findBtn(['submit', 'process', 'evaluate', 'mark as solved']);
      if (sub) (sub.closest('button, a, input') || sub).click();
      if (autoNext) {
        setTimeout(() => {
          const nxt = findBtn(['next', 'continue', 'next question', 'next problem']);
          if (nxt) (nxt.closest('button, a, input') || nxt).click();
        }, 1200);
      }
    },
    args: [doNext],
    world: 'MAIN'
  });
}

async function triggerNext(tabId) {
  await chrome.scripting.executeScript({
    target: { tabId, allFrames: true },
    func: () => {
      const findBtn = (keys) => {
        return [...document.querySelectorAll('button, input[type="button"], input[type="submit"], a.button, a.btn, span.ui-button-text, a')]
          .find(b => keys.some(k => (b.textContent || b.value || '').trim().toLowerCase().includes(k)));
      };
      const nxt = findBtn(['next', 'continue', 'skip', 'next question', 'next problem']);
      if (nxt) (nxt.closest('button, a, input') || nxt).click();
    },
    world: 'MAIN'
  });
}

// ── Injected in target page across all frames (MAIN world) ──
function initEditorFiller(code, opt) {
  return new Promise((resolve) => {
    const mode = opt?.mode || 'typing';
    const delay = opt?.delayMs || 6;

    const syncInputs = () => {
      document.querySelectorAll('textarea, input[type="hidden"], input[type="text"]').forEach(el => {
        const n = `${el.id} ${el.name} ${el.className}`.toLowerCase();
        if (n.includes('code') || n.includes('source') || n.includes('program') || n.includes('editor')) {
          el.value = code;
          el.dispatchEvent(new Event('input', { bubbles: true }));
          el.dispatchEvent(new Event('change', { bubbles: true }));
        }
      });
    };

    let aceEl = document.querySelector('.ace_editor.ace_dark, .ace_editor, div[class*="ace_editor"]');

    if (!aceEl) {
      for (const iframe of document.querySelectorAll('iframe')) {
        try {
          const iDoc = iframe.contentDocument || iframe.contentWindow?.document;
          if (iDoc) {
            const found = iDoc.querySelector('.ace_editor.ace_dark, .ace_editor');
            if (found) { aceEl = found; break; }
          }
        } catch(e) {}
      }
    }

    if (aceEl) {
      let ed = null;

      if (aceEl.env && aceEl.env.editor) ed = aceEl.env.editor;

      if (!ed && window.ace && typeof window.ace.edit === 'function') {
        try { ed = window.ace.edit(aceEl.id || aceEl); } catch(e) {}
      }

      if (!ed && window.parent?.ace && typeof window.parent.ace.edit === 'function') {
        try { ed = window.parent.ace.edit(aceEl.id || aceEl); } catch(e) {}
      }

      if (!ed && window.editor && typeof window.editor.setValue === 'function') {
        ed = window.editor;
      }

      if (ed) {
        try { ed.$blockScrolling = Infinity; } catch(e) {}
        try { ed.focus(); } catch(e) {}

        if (mode === 'typing' && delay > 0) {
          try { ed.setValue('', -1); } catch(e) {}

          const prevB = ed.getBehavioursEnabled ? ed.getBehavioursEnabled() : true;
          if (ed.setBehavioursEnabled) ed.setBehavioursEnabled(false);

          const chars = [...code];
          let i = 0;

          function typeNext() {
            if (i >= chars.length) {
              if (ed.setBehavioursEnabled) ed.setBehavioursEnabled(prevB);
              try { ed.clearSelection(); } catch(e) {}
              syncInputs();
              resolve({ ok: true, method: 'ace-typed' });
              return;
            }
            try { ed.insert(chars[i++]); } catch(e) {}
            setTimeout(typeNext, delay);
          }
          typeNext();
          return;
        } else {
          try {
            ed.setValue('');
            ed.insert(code);
            ed.clearSelection();
          } catch(e) {
            ed.setValue(code, -1);
          }
          syncInputs();
          resolve({ ok: true, method: 'ace-instant' });
          return;
        }
      }

      const aceInput = aceEl.querySelector('textarea.ace_text-input') || aceEl.querySelector('textarea');
      if (aceInput) {
        aceEl.click();
        aceInput.focus();
        document.execCommand('selectAll', false, null);
        document.execCommand('insertText', false, code);

        const dt = new DataTransfer();
        dt.setData('text/plain', code);
        aceInput.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: dt }));

        syncInputs();
        resolve({ ok: true, method: 'ace-input-fallback' });
        return;
      }
    }

    const cmEl = document.querySelector('.CodeMirror');
    if (cmEl && cmEl.CodeMirror) {
      cmEl.CodeMirror.setValue(code);
      syncInputs();
      resolve({ ok: true, method: 'codemirror' });
      return;
    }

    const codeTa = [...document.querySelectorAll('textarea')].find(t => {
      if (t.classList.contains('ace_text-input')) return false;
      const k = `${t.id} ${t.name} ${t.className}`.toLowerCase();
      return k.includes('code') || k.includes('source') || k.includes('program') || k.includes('editor');
    });

    if (codeTa) {
      codeTa.value = code;
      codeTa.dispatchEvent(new Event('input', { bubbles: true }));
      codeTa.dispatchEvent(new Event('change', { bubbles: true }));
      resolve({ ok: true, method: 'code-textarea' });
      return;
    }

    resolve({ ok: false, skipped: true });
  });
}

function clickRunSubmit(options) {
  return new Promise((resolve) => {
    const autoNext = typeof options === 'boolean' ? options : !!options?.autoNext;
    const skipIfFailed = typeof options === 'object' ? !!options?.skipIfFailed : false;

    const findBtn = (keys) => {
      return [...document.querySelectorAll('button, input[type="button"], input[type="submit"], a.button, a.btn, span.ui-button-text, a')]
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

        // Strict test case verification
        const isPass = /(passed|100%|all test cases|success|correct)/i.test(out) && !/(compilation error|wrong answer|runtime error|syntaxerror|fail)/i.test(out);
        const isFail = /(failed|wrong answer|compilation error|error|exception|mismatch)/i.test(out);

        if (isPass) {
          setTimeout(() => {
            const sub = findBtn(['submit', 'process', 'evaluate', 'mark as solved']);
            if (sub) (sub.closest('button, a, input') || sub).click();
            if (autoNext) {
              setTimeout(() => {
                const nxt = findBtn(['next', 'continue', 'next question', 'next problem']);
                if (nxt) (nxt.closest('button, a, input') || nxt).click();
                resolve({ ok: true, output: out, passed: true, submitted: !!sub, next: !!nxt });
              }, 1200);
            } else {
              resolve({ ok: true, output: out, passed: true, submitted: !!sub });
            }
          }, 700);
        } else {
          // Failed or incomplete test cases
          if (skipIfFailed) {
            setTimeout(() => {
              const nxt = findBtn(['next', 'continue', 'skip', 'next question', 'next problem']);
              if (nxt) (nxt.closest('button, a, input') || nxt).click();
              resolve({ ok: true, output: out, passed: false, submitted: false, skippedNext: true });
            }, 800);
          } else {
            resolve({ ok: true, output: out, passed: false, submitted: false, skippedNext: false });
          }
        }
      }
    }, 500);
  });
}

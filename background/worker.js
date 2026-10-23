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

    case 'AUTO_SOLVE_AND_FILL': {
      handleAutoSolveAndFill(message.payload, sendResponse);
      return true; // async
    }

    case 'RUN_CODE': {
      handleRunAndSubmit(message.payload, sendResponse);
      return true; // async
    }

    case 'GET_SETTINGS': {
      chrome.storage.local.get(['groqKey', 'typingSpeed', 'language', 'fillMode', 'modelName'], sendResponse);
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
  const tabs = await chrome.tabs.query({
    url: ['https://www.skillrack.com/*', 'https://skillrack.com/*']
  });
  if (tabs.length > 0) {
    const problemTab = tabs.find(t => t.url && (t.url.includes('codeprogram') || t.url.includes('solve') || t.url.includes('test')));
    return (problemTab || tabs[0]).id;
  }
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
    if (!problem || (!problem.title && !problem.statement)) {
      sendResponse({ error: 'Could not find a problem on this page. Navigate to a SkillRack problem.' });
    } else {
      sendResponse({ ok: true, problem });
    }
  } catch (err) {
    sendResponse({ error: `Scrape failed: ${err.message}` });
  }
}

// --- GENERATE (Groq API) ---
async function handleGenerate({ problem, language, modelName }, sendResponse) {
  const { groqKey, modelName: savedModel } = await chrome.storage.local.get(['groqKey', 'modelName']);
  if (!groqKey) {
    sendResponse({ error: 'No Groq API key configured. Click ⚙ Settings and paste your free key from console.groq.com.' });
    return;
  }

  const model = modelName || savedModel || 'llama-3.3-70b-versatile';

  const systemPrompt = `You are a world-class competitive programming AI and algorithmic expert.
Your job is to generate flawless, optimal, production-grade solutions for coding challenges.

STRICT RULES:
1. Return ONLY the raw, compilable ${language} source code.
2. NO markdown formatting, NO code blocks (\`\`\`), NO preamble, NO explanation, NO comments unless essential.
3. Read all input strictly from Standard Input (stdin) and print output strictly to Standard Output (stdout).
4. Match the exact output format down to every space, line break, and case. Do not output extraneous text like "Enter number:".
5. For Java:
   - The main class MUST be named "Hello" (i.e. 'public class Hello { public static void main(String[] args) throws Exception { ... } }') because SkillRack requires 'Hello'.
6. For C / C++:
   - Include standard headers (<stdio.h>, <stdlib.h>, <string.h>, <math.h>, <stdbool.h> or <iostream>, <vector>, <string>, <algorithm>, <cmath>).
   - Use 'long long' when constraints or values can exceed 2*10^9.
7. For Python 3:
   - Handle fast I/O using sys.stdin.read().split() or input().strip() as appropriate.
   - Handle multi-line and end-of-file inputs properly without crashing.
8. Optimize time and space complexities to fit within 1.0 - 2.0s limits based on the boundary conditions.
OUTPUT RAW SOURCE CODE ONLY.`;

  // Build structured user prompt
  let promptBody = `Problem Title: ${problem.title || 'Coding Challenge'}\n\n`;
  if (problem.statement) {
    promptBody += `Problem Statement:\n${problem.statement}\n\n`;
  }
  if (problem.constraints) {
    promptBody += `Boundary Condition(s) / Constraints:\n${problem.constraints}\n\n`;
  }
  if (problem.inputFormat) {
    promptBody += `Input Format:\n${problem.inputFormat}\n\n`;
  }
  if (problem.outputFormat) {
    promptBody += `Output Format:\n${problem.outputFormat}\n\n`;
  }

  if (problem.examples && problem.examples.length > 0) {
    problem.examples.forEach((ex, idx) => {
      promptBody += `Example ${idx + 1}:\nInput:\n${ex.input}\nOutput:\n${ex.output}\n\n`;
    });
  } else if (problem.sampleInput || problem.sampleOutput) {
    if (problem.sampleInput) promptBody += `Sample Input:\n${problem.sampleInput}\n`;
    if (problem.sampleOutput) promptBody += `Sample Output:\n${problem.sampleOutput}\n`;
  }

  promptBody += `Target Language: ${language}\nProvide the complete, optimal ${language} solution now.`;

  try {
    const code = await callGroqWithFallback(groqKey, model, systemPrompt, promptBody);
    sendResponse({ ok: true, code });
  } catch (err) {
    sendResponse({ error: `Groq error: ${err.message}` });
  }
}

// Call Groq with primary model and automatic fallback if needed
async function callGroqWithFallback(apiKey, primaryModel, systemPrompt, userPrompt) {
  const modelsToTry = [primaryModel];
  if (primaryModel !== 'llama-3.3-70b-versatile') modelsToTry.push('llama-3.3-70b-versatile');
  modelsToTry.push('llama-3.1-8b-instant');

  let lastError = null;

  for (const model of modelsToTry) {
    try {
      const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${apiKey}`
        },
        body: JSON.stringify({
          model,
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userPrompt }
          ],
          temperature: 0.1,
          max_tokens: 3000
        })
      });

      if (!response.ok) {
        const errJson = await response.json().catch(() => ({}));
        throw new Error(errJson.error?.message || `HTTP ${response.status} ${response.statusText}`);
      }

      const data = await response.json();
      let code = data.choices?.[0]?.message?.content?.trim();
      if (!code) throw new Error('Model returned an empty response.');

      // Strip markdown code fences if model enclosed it
      code = code.replace(/^```[a-zA-Z0-9_+\-]*\n?/, '').replace(/```\s*$/, '').trim();
      return code;
    } catch (err) {
      lastError = err;
      console.warn(`Model ${model} failed: ${err.message}, trying fallback...`);
    }
  }

  throw lastError || new Error('All model attempts failed.');
}

// --- TYPE / FILL ---
async function handleType({ code, fillMode, typingSpeed }, sendResponse) {
  const activeTabId = await findSkillRackTabId();
  if (!activeTabId) {
    sendResponse({ error: 'No SkillRack tab found. Open a problem page first.' });
    return;
  }

  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId: activeTabId, allFrames: true },
      func: initSmartEditorFiller,
      args: [code, { mode: fillMode || 'instant', delayMs: typingSpeed || 12 }],
      world: 'MAIN' // CRITICAL: Run in page's main JS context to access window.ace/CodeMirror
    });

    const success = results.some(r => r?.result?.ok);
    const firstError = results.find(r => r?.result?.error)?.result?.error;

    if (!success && firstError) {
      sendResponse({ error: firstError });
    } else if (!success) {
      sendResponse({ error: 'Could not find any code editor on the page.' });
    } else {
      sendResponse({ ok: true });
    }
  } catch (err) {
    sendResponse({ error: `Editor fill failed: ${err.message}` });
  }
}

// --- 1-CLICK AUTO SOLVE & FILL ---
async function handleAutoSolveAndFill({ language, fillMode, typingSpeed, autoRun, autoNext }, sendResponse) {
  const activeTabId = await findSkillRackTabId();
  if (!activeTabId) {
    sendResponse({ error: 'No SkillRack tab found. Open a problem page first.' });
    return;
  }

  // 1. Scrape
  let problem = null;
  try {
    const scrapeRes = await chrome.scripting.executeScript({
      target: { tabId: activeTabId },
      files: ['content/scraper.js']
    });
    problem = scrapeRes[0]?.result;
    if (!problem || (!problem.title && !problem.statement)) {
      sendResponse({ error: 'Failed to extract problem from current page.' });
      return;
    }
  } catch (err) {
    sendResponse({ error: `Scrape step failed: ${err.message}` });
    return;
  }

  const targetLang = language || problem.detectedLanguage || 'Python 3';

  // 2. Generate
  const { groqKey, modelName } = await chrome.storage.local.get(['groqKey', 'modelName']);
  if (!groqKey) {
    sendResponse({ error: 'No Groq API key found. Please open ⚙ Settings and save your key.' });
    return;
  }

  let code = '';
  try {
    code = await new Promise((resolve, reject) => {
      handleGenerate({ problem, language: targetLang, modelName }, (res) => {
        if (res.error) reject(new Error(res.error));
        else resolve(res.code);
      });
    });
  } catch (err) {
    sendResponse({ error: err.message, problem });
    return;
  }

  // 3. Fill Editor
  try {
    await new Promise((resolve, reject) => {
      handleType({ code, fillMode: fillMode || 'instant', typingSpeed: typingSpeed || 12 }, (res) => {
        if (res.error) reject(new Error(res.error));
        else resolve(res);
      });
    });
  } catch (err) {
    sendResponse({ error: err.message, problem, code });
    return;
  }

  // 4. Auto Run if requested
  let runOutput = null;
  if (autoRun) {
    try {
      const runRes = await new Promise((resolve, reject) => {
        handleRunAndSubmit({ autoNext }, (res) => {
          if (res.error) reject(new Error(res.error));
          else resolve(res);
        });
      });
      runOutput = runRes?.output;
    } catch (e) {
      console.warn('Auto run failed:', e);
    }
  }

  sendResponse({
    ok: true,
    problem,
    code,
    language: targetLang,
    runOutput
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// initSmartEditorFiller — runs IN page context across all frames
// ─────────────────────────────────────────────────────────────────────────────
function initSmartEditorFiller(code, options) {
  return new Promise((resolve) => {
    const mode = options?.mode || 'instant';
    const delayMs = options?.delayMs || 12;

    // Helper: dispatch input & change events on form inputs
    const syncFormInputs = () => {
      document.querySelectorAll('textarea, input[type="hidden"], input[type="text"]').forEach(el => {
        const idName = `${el.id || ''} ${el.name || ''}`.toLowerCase();
        if (idName.includes('code') || idName.includes('source') || idName.includes('program') || idName.includes('editor')) {
          el.value = code;
          el.dispatchEvent(new Event('input', { bubbles: true }));
          el.dispatchEvent(new Event('change', { bubbles: true }));
        }
      });
    };

    // ── 1. ACE EDITOR SUPPORT ───────────────────────────────────────────
    const aceEl = document.querySelector('.ace_editor');
    if (aceEl) {
      let ed = null;
      if (aceEl.env && aceEl.env.editor) ed = aceEl.env.editor;
      if (!ed && window.ace && aceEl.id) { try { ed = window.ace.edit(aceEl.id); } catch(e) {} }
      if (!ed && window.ace)             { try { ed = window.ace.edit(aceEl);    } catch(e) {} }
      if (!ed && window.editor && typeof window.editor.setValue === 'function') ed = window.editor;

      if (ed && typeof ed.setValue === 'function') {
        // INSTANT FILL MODE (Recommended - fast, zero syntax corruption)
        if (mode === 'instant' || delayMs <= 1) {
          try {
            ed.setValue(code, -1);
            ed.clearSelection();
            ed.focus();
            syncFormInputs();
            resolve({ ok: true, method: 'ace-instant' });
            return;
          } catch(e) {
            console.warn('Ace instant fill error:', e);
          }
        } else {
          // TYPING SIMULATION MODE
          try {
            // CRITICAL: Disable auto-closing brackets and auto-indent so Ace doesn't mangle code!
            const prevBehaviours = ed.getBehavioursEnabled ? ed.getBehavioursEnabled() : true;
            if (ed.setBehavioursEnabled) ed.setBehavioursEnabled(false);

            ed.setValue('', -1);
            ed.clearSelection();
            ed.focus();

            const chars = [...code];
            let i = 0;

            function typeNext() {
              if (i >= chars.length) {
                if (ed.setBehavioursEnabled) ed.setBehavioursEnabled(prevBehaviours);
                ed.clearSelection();
                syncFormInputs();
                resolve({ ok: true, method: 'ace-typed' });
                return;
              }
              try { ed.insert(chars[i]); } catch(e) {}
              i++;
              // Jitter typing speed slightly for human-like simulation
              const jitter = Math.floor(Math.random() * 6) - 3;
              const nextDelay = Math.max(3, delayMs + jitter);
              setTimeout(typeNext, nextDelay);
            }
            typeNext();
            return;
          } catch(e) {
            console.warn('Ace typing mode failed, falling back to instant:', e);
            ed.setValue(code, -1);
            syncFormInputs();
            resolve({ ok: true, method: 'ace-instant-fallback' });
            return;
          }
        }
      }

      // Ace textarea fallback
      const aceTextarea = aceEl.querySelector('textarea.ace_text-input');
      if (aceTextarea) {
        aceEl.click();
        aceTextarea.focus();
        const dt = new DataTransfer();
        dt.setData('text/plain', code);
        aceTextarea.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: dt }));
        setTimeout(() => {
          syncFormInputs();
          resolve({ ok: true, method: 'ace-clipboard' });
        }, 150);
        return;
      }
    }

    // ── 2. CODEMIRROR SUPPORT ──────────────────────────────────────────
    const cmEl = document.querySelector('.CodeMirror');
    if (cmEl && cmEl.CodeMirror) {
      try {
        cmEl.CodeMirror.setValue(code);
        cmEl.CodeMirror.focus();
        syncFormInputs();
        resolve({ ok: true, method: 'codemirror' });
        return;
      } catch(e) {}
    }

    // ── 3. MONACO EDITOR SUPPORT ───────────────────────────────────────
    if (window.monaco && window.monaco.editor) {
      try {
        const editors = window.monaco.editor.getEditors();
        if (editors && editors.length > 0) {
          editors[0].setValue(code);
          syncFormInputs();
          resolve({ ok: true, method: 'monaco' });
          return;
        }
      } catch(e) {}
    }

    // ── 4. STANDARD TEXTAREA / INPUT FALLBACK ──────────────────────────
    const textareas = [...document.querySelectorAll('textarea:not(.ace_text-input)')];
    const candidateTa = textareas.find(t => {
      const idName = `${t.id || ''} ${t.name || ''} ${t.className || ''}`.toLowerCase();
      return idName.includes('code') || idName.includes('editor') || idName.includes('program') || idName.includes('source');
    }) || textareas[0];

    if (candidateTa) {
      candidateTa.value = code;
      candidateTa.dispatchEvent(new Event('input', { bubbles: true }));
      candidateTa.dispatchEvent(new Event('change', { bubbles: true }));
      syncFormInputs();
      resolve({ ok: true, method: 'textarea' });
      return;
    }

    resolve({ ok: false, skipped: true });
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
      target: { tabId: activeTabId, allFrames: true },
      func: clickRunAndSubmit,
      args: [autoNext || false],
      world: 'MAIN'
    });

    const success = results.find(r => r?.result?.ok);
    const errResult = results.find(r => r?.result?.error);

    if (success) {
      sendResponse({ ok: true, output: success.result.output, submitted: success.result.submitted });
    } else if (errResult) {
      sendResponse({ error: errResult.result.error });
    } else {
      sendResponse({ error: 'Run button not found.' });
    }
  } catch (err) {
    sendResponse({ error: `Run failed: ${err.message}` });
  }
}

function clickRunAndSubmit(autoNext) {
  return new Promise((resolve) => {
    const findBtn = (labels) => {
      const allBtns = [...document.querySelectorAll('button, input[type="button"], input[type="submit"], a.button, a.btn, span.ui-button-text')];
      return allBtns.find(b => {
        const txt = (b.textContent || b.value || b.innerText || '').trim().toLowerCase();
        return labels.some(l => txt === l || txt.includes(l));
      });
    };

    const runBtn = findBtn(['run', 'run code', 'execute', 'compile']);
    if (!runBtn) {
      resolve({ ok: false, skipped: true });
      return;
    }

    // Trigger run button click
    const clickTarget = runBtn.closest('button, a, input') || runBtn;
    clickTarget.click();

    // Poll for compilation / execution output
    let waited = 0;
    const maxWait = 20000;
    const interval = 500;

    const poll = setInterval(() => {
      waited += interval;

      const outputSels = [
        '#output', '.output', '[id*="output"]', '[class*="output"]',
        '#result', '.result', '[id*="result"]', 'pre.code', '.console',
        '.ui-terminal-content'
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

        // Click Submit
        setTimeout(() => {
          const submitBtn = findBtn(['submit', 'process', 'evaluate', 'save & submit', 'mark as solved']);
          if (submitBtn) {
            const submitTarget = submitBtn.closest('button, a, input') || submitBtn;
            submitTarget.click();

            if (autoNext) {
              setTimeout(() => {
                const nextBtn = findBtn(['next', 'next problem', 'next question', 'continue']);
                if (nextBtn) {
                  (nextBtn.closest('button, a, input') || nextBtn).click();
                }
                resolve({ ok: true, output: outputText, submitted: true });
              }, 1500);
            } else {
              resolve({ ok: true, output: outputText, submitted: true });
            }
          } else {
            resolve({ ok: true, output: outputText, submitted: false });
          }
        }, 800);
      }
    }, interval);
  });
}

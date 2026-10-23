// popup/popup.js
const $ = (id) => document.getElementById(id);

let currentProblem = null;
let generatedCode  = null;

// DOM elements
const statusDot      = $('statusDot');
const statusText     = $('statusText');
const problemCard    = $('problemCard');
const problemTitle   = $('problemTitle');
const problemMeta    = $('problemMeta');
const autoPilotBtn   = $('autoPilotBtn');
const pilotStats     = $('pilotStats');
const statSolved     = $('statSolved');
const statSkipped    = $('statSkipped');
const pilotState     = $('pilotState');
const autoSolveBtn   = $('autoSolveBtn');
const scrapeBtn      = $('scrapeBtn');
const langSelect     = $('langSelect');
const fillModeSelect = $('fillModeSelect');
const speedField     = $('speedField');
const speedSlider    = $('speedSlider');
const speedLabel     = $('speedLabel');
const codeBlock      = $('codeBlock');
const codeContent    = $('codeContent');
const copyBtn        = $('copyBtn');
const errorBox       = $('errorBox');
const errorText      = $('errorText');
const mainPanel      = $('mainPanel');
const settingsPanel  = $('settingsPanel');
const settingsToggle = $('settingsToggle');
const apiKeyInput    = $('apiKeyInput');
const toggleApiKey   = $('toggleApiKey');
const modelSelect    = $('modelSelect');
const refreshModelsBtn = $('refreshModelsBtn');
const saveSettingsBtn= $('saveSettingsBtn');
const skipOnFailCheck= $('skipOnFailCheck');
const autoRunCheck   = $('autoRunCheck');
const autoNextCheck  = $('autoNextCheck');

let isAutoPilot = false;
let solvedCount = 0;
let skippedCount = 0;

// Init
document.addEventListener('DOMContentLoaded', async () => {
  const s = await msg({ type: 'GET_SETTINGS' });
  if (s.groqKey)     apiKeyInput.value    = s.groqKey;
  speedSlider.value    = s.typingSpeed || 6;
  if (s.language)    langSelect.value     = s.language;
  fillModeSelect.value = s.fillMode || 'typing';
  if (s.modelName)   modelSelect.value    = s.modelName;
  updateModeView();
});

// Mode change
fillModeSelect.addEventListener('change', () => {
  updateModeView();
  msg({ type: 'SAVE_SETTINGS', payload: { fillMode: fillModeSelect.value } });
});

function updateModeView() {
  speedField.style.display = fillModeSelect.value === 'typing' ? 'flex' : 'none';
  speedLabel.textContent = `${speedSlider.value}ms / char`;
}

// Settings toggle & visibility
settingsToggle.addEventListener('click', () => {
  const open = settingsPanel.style.display === 'none';
  mainPanel.style.display = open ? 'none' : 'flex';
  settingsPanel.style.display = open ? 'flex' : 'none';
  settingsToggle.textContent = open ? '✕' : '⚙';
});

toggleApiKey.addEventListener('click', () => {
  const pass = apiKeyInput.type === 'password';
  apiKeyInput.type = pass ? 'text' : 'password';
  toggleApiKey.textContent = pass ? '🙈' : '👁';
});

saveSettingsBtn.addEventListener('click', async () => {
  const groqKey = apiKeyInput.value.trim();
  if (!groqKey) return showError('Enter your Groq API key.');

  saveSettingsBtn.disabled = true;
  await msg({
    type: 'SAVE_SETTINGS',
    payload: {
      groqKey,
      modelName: modelSelect.value,
      typingSpeed: +speedSlider.value,
      language: langSelect.value,
      fillMode: fillModeSelect.value
    }
  });
  saveSettingsBtn.disabled = false;
  settingsToggle.click();
  setStatus('done', 'Settings saved ✓');
});

refreshModelsBtn.addEventListener('click', async () => {
  const key = apiKeyInput.value.trim();
  if (!key) return showError('Enter Groq key first.');
  refreshModelsBtn.textContent = '...';
  const res = await msg({ type: 'FETCH_MODELS', payload: { groqKey: key } });
  refreshModelsBtn.textContent = '🔄 Sync';
  if (res.error) return showError(res.error);
  if (res.models?.length) {
    const cur = modelSelect.value;
    modelSelect.innerHTML = res.models.map(m => `<option value="${m}">${m}</option>`).join('');
    if (res.models.includes(cur)) modelSelect.value = cur;
    setStatus('done', `Synced ${res.models.length} live models ✓`);
  }
});

speedSlider.addEventListener('input', () => {
  speedLabel.textContent = `${speedSlider.value}ms / char`;
  msg({ type: 'SAVE_SETTINGS', payload: { typingSpeed: +speedSlider.value } });
});

// Autonomous Auto-Pilot Controller
autoPilotBtn.addEventListener('click', async () => {
  if (isAutoPilot) {
    // Stop
    isAutoPilot = false;
    autoPilotBtn.textContent = '🚀 Start Autonomous Auto-Pilot';
    autoPilotBtn.style.background = '#00d2ff';
    autoPilotBtn.style.color = '#000';
    pilotState.textContent = 'Stopped';
    setStatus('idle', 'Auto-pilot stopped');
    return;
  }

  // Start
  isAutoPilot = true;
  autoPilotBtn.textContent = '⏹ Stop Auto-Pilot';
  autoPilotBtn.style.background = '#ff4d6d';
  autoPilotBtn.style.color = '#fff';
  pilotStats.style.display = 'flex';
  hideError();

  while (isAutoPilot) {
    pilotState.textContent = 'Solving ⟳';
    setStatus('running', 'Auto-pilot: solving current problem...');

    const res = await msg({
      type: 'AUTO_PILOT_STEP',
      payload: {
        language: langSelect.value,
        fillMode: fillModeSelect.value,
        typingSpeed: +speedSlider.value,
        modelName: modelSelect.value,
        skipOnFail: skipOnFailCheck.checked
      }
    });

    if (!isAutoPilot) break;

    if (res.error) {
      pilotState.textContent = 'Error (3s retry)...';
      setStatus('error', `Auto-pilot: ${res.error}`);
      await new Promise(r => setTimeout(r, 3000));
      continue;
    }

    if (res.status === 'passed') {
      solvedCount++;
      statSolved.textContent = solvedCount;
      pilotState.textContent = 'Passed ✓ (Next)';
      setStatus('done', `Solved: ${res.problemTitle || 'Problem'}`);
    } else {
      skippedCount++;
      statSkipped.textContent = skippedCount;
      pilotState.textContent = 'Skipped ⏭ (Next)';
      setStatus('running', `Skipped: ${res.problemTitle || 'Problem'}`);
    }

    // Wait 2.5s for SkillRack page transition to complete
    pilotState.textContent = 'Loading next...';
    await new Promise(r => setTimeout(r, 2500));
  }
});

// Auto-Solve & Fill (Core Flow)
async function runAutoSolve() {
  hideError();
  setBusy(true);
  setStatus('running', 'Solving & injecting...');

  const res = await msg({
    type: 'AUTO_SOLVE_AND_FILL',
    payload: {
      language: langSelect.value,
      fillMode: fillModeSelect.value,
      typingSpeed: +speedSlider.value,
      autoRun: autoRunCheck.checked,
      autoNext: autoNextCheck.checked,
      modelName: modelSelect.value
    }
  });

  setBusy(false);
  if (res.error) {
    setStatus('error', 'Failed');
    showError(res.error);
    return;
  }

  if (res.problem) displayProblem(res.problem);
  if (res.code) displayCode(res.code);

  setStatus('done', res.runOutput ? `✓ Solved & executed (${res.language})` : `✓ Code filled (${res.language})`);
}

autoSolveBtn.addEventListener('click', runAutoSolve);

// Manual Scan
scrapeBtn.addEventListener('click', async () => {
  hideError();
  setBusy(true);
  setStatus('running', 'Scanning page...');

  const res = await msg({ type: 'SCRAPE_PROBLEM' });
  setBusy(false);

  if (res.error) {
    setStatus('error', 'Scan failed');
    return showError(res.error);
  }

  currentProblem = res.problem;
  displayProblem(currentProblem);

  if (currentProblem.detectedLanguage) {
    const opt = [...langSelect.options].find(o => o.value.toLowerCase().includes(currentProblem.detectedLanguage.toLowerCase()));
    if (opt) langSelect.value = opt.value;
  }
  setStatus('done', 'Problem detected — click 1-Click Auto Solve ✓');
});

// UI helpers
function displayProblem(p) {
  problemTitle.textContent = p.title || 'Untitled';
  const meta = [p.detectedLanguage && `Lang: ${p.detectedLanguage}`, p.constraints && 'Constraints detected', p.examples?.length && `${p.examples.length} test case(s)`].filter(Boolean).join(' • ');
  problemMeta.textContent = meta || p.url || '';
  problemCard.style.display = 'block';
}

function displayCode(c) {
  generatedCode = c;
  codeContent.textContent = c;
  codeBlock.style.display = 'block';
}

function setBusy(b) {
  autoSolveBtn.disabled = b;
  scrapeBtn.disabled = b;
}

function setStatus(dot, txt) {
  statusDot.className = `status-dot ${dot}`;
  statusText.textContent = txt;
}

function showError(t) {
  errorText.textContent = t;
  errorBox.style.display = 'flex';
}

function hideError() {
  errorBox.style.display = 'none';
}

copyBtn.addEventListener('click', () => {
  if (!generatedCode) return;
  navigator.clipboard.writeText(generatedCode).then(() => {
    copyBtn.textContent = '✓ Copied!';
    setTimeout(() => { copyBtn.textContent = 'Copy'; }, 1500);
  });
});

function msg(m) {
  return new Promise(resolve => {
    chrome.runtime.sendMessage(m, r => resolve(chrome.runtime.lastError ? { error: chrome.runtime.lastError.message } : (r || {})));
  });
}

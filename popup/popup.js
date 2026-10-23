// popup/popup.js

const $ = (id) => document.getElementById(id);

let currentProblem = null;
let generatedCode  = null;

// --- DOM elements ---
const statusDot        = $('statusDot');
const statusText       = $('statusText');
const problemCard      = $('problemCard');
const problemTitle     = $('problemTitle');
const problemMeta      = $('problemMeta');
const autoSolveBtn     = $('autoSolveBtn');
const scrapeBtn        = $('scrapeBtn');
const solveBtn         = $('solveBtn');
const langSelect       = $('langSelect');
const fillModeSelect   = $('fillModeSelect');
const speedField       = $('speedField');
const speedSlider      = $('speedSlider');
const speedLabel       = $('speedLabel');
const codeBlock        = $('codeBlock');
const codeContent      = $('codeContent');
const copyBtn          = $('copyBtn');
const errorBox         = $('errorBox');
const errorText        = $('errorText');
const mainPanel        = $('mainPanel');
const settingsPanel    = $('settingsPanel');
const settingsToggle   = $('settingsToggle');
const apiKeyInput      = $('apiKeyInput');
const toggleApiKey     = $('toggleApiKey');
const modelSelect      = $('modelSelect');
const saveSettingsBtn  = $('saveSettingsBtn');
const autoRunCheck     = $('autoRunCheck');
const autoNextCheck    = $('autoNextCheck');

// --- Initialization ---
document.addEventListener('DOMContentLoaded', async () => {
  const settings = await msg({ type: 'GET_SETTINGS' });
  if (settings.groqKey)     apiKeyInput.value    = settings.groqKey;
  if (settings.typingSpeed) speedSlider.value    = settings.typingSpeed;
  if (settings.language)    langSelect.value     = settings.language;
  if (settings.fillMode)    fillModeSelect.value = settings.fillMode;
  if (settings.modelName)   modelSelect.value    = settings.modelName;

  updateSpeedVisibility();
  updateSpeedLabel();
});

// --- Mode Toggle ---
fillModeSelect.addEventListener('change', () => {
  updateSpeedVisibility();
  msg({ type: 'SAVE_SETTINGS', payload: { fillMode: fillModeSelect.value } });
});

function updateSpeedVisibility() {
  speedField.style.display = fillModeSelect.value === 'typing' ? 'flex' : 'none';
}

// --- Settings Toggle ---
settingsToggle.addEventListener('click', () => {
  const isSettings = settingsPanel.style.display !== 'none';
  mainPanel.style.display     = isSettings ? 'flex' : 'none';
  settingsPanel.style.display = isSettings ? 'none' : 'flex';
  settingsToggle.textContent  = isSettings ? '⚙' : '✕';
});

// --- API Key Visibility Toggle ---
toggleApiKey.addEventListener('click', () => {
  const isHidden = apiKeyInput.type === 'password';
  apiKeyInput.type = isHidden ? 'text' : 'password';
  toggleApiKey.textContent = isHidden ? '🙈' : '👁';
});

// --- Save Settings ---
saveSettingsBtn.addEventListener('click', async () => {
  const groqKey   = apiKeyInput.value.trim();
  const modelName = modelSelect.value;
  if (!groqKey) {
    showError('Paste your Groq key (starts with gsk_)');
    return;
  }

  saveSettingsBtn.textContent = 'Saving...';
  saveSettingsBtn.disabled = true;

  await msg({
    type: 'SAVE_SETTINGS',
    payload: {
      groqKey,
      modelName,
      typingSpeed: +speedSlider.value,
      language: langSelect.value,
      fillMode: fillModeSelect.value
    }
  });

  saveSettingsBtn.textContent = '✓ Saved!';
  setTimeout(() => {
    saveSettingsBtn.textContent = 'Save Settings';
    saveSettingsBtn.disabled = false;
    mainPanel.style.display = 'flex';
    settingsPanel.style.display = 'none';
    settingsToggle.textContent = '⚙';
    setStatus('done', 'Settings saved ✓');
  }, 800);
});

// --- Speed Slider ---
speedSlider.addEventListener('input', () => {
  updateSpeedLabel();
  msg({ type: 'SAVE_SETTINGS', payload: { typingSpeed: +speedSlider.value } });
});

function updateSpeedLabel() {
  speedLabel.textContent = `${speedSlider.value}ms / char`;
}

// --- ⚡ 1-Click Auto Solve & Fill ---
autoSolveBtn.addEventListener('click', async () => {
  hideError();
  setBusy(true);
  setStatus('running', '1. Scanning SkillRack problem...');

  const res = await msg({
    type: 'AUTO_SOLVE_AND_FILL',
    payload: {
      language: langSelect.value,
      fillMode: fillModeSelect.value,
      typingSpeed: +speedSlider.value,
      autoRun: autoRunCheck.checked,
      autoNext: autoNextCheck.checked
    }
  });

  setBusy(false);

  if (res.error) {
    setStatus('error', 'Auto-solve failed');
    showError(res.error);
    if (res.problem) displayProblem(res.problem);
    if (res.code) displayCode(res.code);
    return;
  }

  if (res.problem) displayProblem(res.problem);
  if (res.code) displayCode(res.code);

  if (res.runOutput) {
    setStatus('done', `✓ Solved, filled & executed! (${res.language})`);
  } else {
    setStatus('done', `✓ Solution filled into code box! (${res.language})`);
  }
});

// --- Manual Scrape Button ---
scrapeBtn.addEventListener('click', async () => {
  hideError();
  setBusy(true);
  setStatus('running', 'Scanning page for problem & constraints...');

  const res = await msg({ type: 'SCRAPE_PROBLEM' });
  setBusy(false);

  if (res.error) {
    setStatus('error', 'Failed to scan problem');
    showError(res.error);
    return;
  }

  currentProblem = res.problem;
  displayProblem(currentProblem);

  // Auto-detect language
  if (currentProblem.detectedLanguage) {
    const match = [...langSelect.options].find(o =>
      o.value.toLowerCase().includes(currentProblem.detectedLanguage.toLowerCase()) ||
      currentProblem.detectedLanguage.toLowerCase().includes(o.value.toLowerCase())
    );
    if (match) langSelect.value = match.value;
  }

  solveBtn.disabled = false;
  setStatus('done', 'Problem extracted — click Solve & Fill ✓');
});

// --- Manual Solve & Fill Button ---
solveBtn.addEventListener('click', async () => {
  if (!currentProblem) return;

  hideError();
  setBusy(true);

  // Step 1: Generate Code
  setStatus('running', `Generating optimal ${langSelect.value} solution...`);
  const genRes = await msg({
    type: 'GENERATE_CODE',
    payload: { problem: currentProblem, language: langSelect.value, modelName: modelSelect.value }
  });

  if (genRes.error) {
    setBusy(false);
    setStatus('error', 'Generation failed');
    showError(genRes.error);
    return;
  }

  generatedCode = genRes.code;
  displayCode(generatedCode);

  // Step 2: Inject into Editor
  const isTyping = fillModeSelect.value === 'typing';
  setStatus('running', isTyping ? 'Simulating typing into code editor...' : 'Injecting solution into editor...');

  const fillRes = await msg({
    type: 'TYPE_CODE',
    payload: {
      code: generatedCode,
      fillMode: fillModeSelect.value,
      typingSpeed: +speedSlider.value
    }
  });

  if (fillRes.error) {
    setBusy(false);
    setStatus('error', 'Failed to inject code');
    showError(fillRes.error);
    return;
  }

  // Step 3: Run if checked
  if (autoRunCheck.checked) {
    setStatus('running', 'Executing & submitting code...');
    const runRes = await msg({
      type: 'RUN_CODE',
      payload: { autoNext: autoNextCheck.checked }
    });

    setBusy(false);
    if (runRes.error) {
      setStatus('error', 'Execution error');
      showError(runRes.error);
    } else {
      setStatus('done', '✓ Solved, filled, run & submitted!');
    }
  } else {
    setBusy(false);
    setStatus('done', '✓ Code filled into editor box!');
  }
});

// --- Display Helpers ---
function displayProblem(prob) {
  problemTitle.textContent = prob.title || 'Untitled Problem';
  let meta = prob.detectedLanguage ? `Lang: ${prob.detectedLanguage}` : '';
  if (prob.constraints) meta += (meta ? ' • ' : '') + 'Constraints detected';
  if (prob.examples && prob.examples.length) meta += (meta ? ' • ' : '') + `${prob.examples.length} test case(s)`;
  problemMeta.textContent = meta || prob.url || '';
  problemCard.style.display = 'block';
}

function displayCode(code) {
  generatedCode = code;
  codeContent.textContent = code;
  codeBlock.style.display = 'block';
}

function setBusy(busy) {
  autoSolveBtn.disabled = busy;
  scrapeBtn.disabled    = busy;
  solveBtn.disabled     = busy || !currentProblem;
}

// --- Copy Button ---
copyBtn.addEventListener('click', () => {
  if (!generatedCode) return;
  navigator.clipboard.writeText(generatedCode).then(() => {
    copyBtn.textContent = '✓ Copied!';
    copyBtn.classList.add('copied');
    setTimeout(() => {
      copyBtn.textContent = 'Copy';
      copyBtn.classList.remove('copied');
    }, 1800);
  });
});

// --- Helpers ---
function setStatus(state, text) {
  statusDot.className    = `status-dot ${state}`;
  statusText.textContent = text;
}

function showError(text) {
  errorText.textContent  = text;
  errorBox.style.display = 'flex';
}

function hideError() {
  errorBox.style.display = 'none';
}

function msg(message) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage(message, (response) => {
      if (chrome.runtime.lastError) {
        resolve({ error: chrome.runtime.lastError.message });
      } else {
        resolve(response || {});
      }
    });
  });
}

// popup/popup.js

const $ = (id) => document.getElementById(id);

let currentProblem = null;
let generatedCode  = null;

// --- DOM refs ---
const statusDot      = $('statusDot');
const statusText     = $('statusText');
const problemCard    = $('problemCard');
const problemTitle   = $('problemTitle');
const problemMeta    = $('problemMeta');
const scrapeBtn      = $('scrapeBtn');
const solveBtn       = $('solveBtn');
const langSelect     = $('langSelect');
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
const saveSettingsBtn= $('saveSettingsBtn');
const autoRunCheck   = $('autoRunCheck');
const autoNextCheck  = $('autoNextCheck');

// --- Init ---
document.addEventListener('DOMContentLoaded', async () => {
  const settings = await msg({ type: 'GET_SETTINGS' });
  if (settings.groqKey)     apiKeyInput.value  = settings.groqKey;
  if (settings.typingSpeed) speedSlider.value  = settings.typingSpeed;
  if (settings.language)    langSelect.value   = settings.language;
  updateSpeedLabel();
});

// --- Settings toggle ---
settingsToggle.addEventListener('click', () => {
  const isSettings = settingsPanel.style.display !== 'none';
  mainPanel.style.display    = isSettings ? 'flex' : 'none';
  settingsPanel.style.display= isSettings ? 'none' : 'flex';
  settingsToggle.textContent = isSettings ? '⚙' : '✕';
});

// --- API key visibility toggle ---
toggleApiKey.addEventListener('click', () => {
  const isHidden = apiKeyInput.type === 'password';
  apiKeyInput.type = isHidden ? 'text' : 'password';
  toggleApiKey.textContent = isHidden ? '🙈' : '👁';
});

// --- Save settings ---
saveSettingsBtn.addEventListener('click', async () => {
  const groqKey = apiKeyInput.value.trim();
  if (!groqKey) {
    showError('Paste your Groq key (starts with gsk_)');
    return;
  }
  saveSettingsBtn.textContent = 'Saving...';
  saveSettingsBtn.disabled = true;
  await msg({
    type: 'SAVE_SETTINGS',
    payload: { groqKey, typingSpeed: +speedSlider.value, language: langSelect.value }
  });
  saveSettingsBtn.textContent = '✓ Saved!';
  setTimeout(() => {
    saveSettingsBtn.textContent = 'Save Settings';
    saveSettingsBtn.disabled = false;
    mainPanel.style.display = 'flex';
    settingsPanel.style.display = 'none';
    settingsToggle.textContent = '⚙';
    setStatus('done', 'Settings saved ✓');
  }, 900);
});

// --- Speed slider ---
speedSlider.addEventListener('input', () => {
  updateSpeedLabel();
  msg({ type: 'SAVE_SETTINGS', payload: { typingSpeed: +speedSlider.value } });
});

function updateSpeedLabel() {
  speedLabel.textContent = `${speedSlider.value}ms / char`;
}

// --- Scrape ---
scrapeBtn.addEventListener('click', async () => {
  setStatus('running', 'Scanning page for problem...');
  hideError();
  problemCard.style.display = 'none';
  codeBlock.style.display   = 'none';
  solveBtn.disabled = true;
  scrapeBtn.disabled = true;

  const res = await msg({ type: 'SCRAPE_PROBLEM' });

  scrapeBtn.disabled = false;

  if (res.error) {
    setStatus('error', 'Failed to read problem');
    showError(res.error);
    return;
  }

  currentProblem = res.problem;
  problemTitle.textContent = currentProblem.title || 'Untitled Problem';
  problemMeta.textContent  = currentProblem.url;
  problemCard.style.display = 'block';

  // Auto-set language if detected from the page
  if (currentProblem.detectedLanguage) {
    const match = [...langSelect.options].find(o =>
      o.value.toLowerCase().includes(currentProblem.detectedLanguage.toLowerCase()) ||
      currentProblem.detectedLanguage.toLowerCase().includes(o.value.toLowerCase())
    );
    if (match) langSelect.value = match.value;
  }

  solveBtn.disabled = false;
  setStatus('done', 'Problem found — ready to solve ✓');
});

// --- Solve & Type ---
solveBtn.addEventListener('click', async () => {
  if (!currentProblem) return;

  hideError();
  codeBlock.style.display = 'none';
  solveBtn.disabled  = true;
  scrapeBtn.disabled = true;

  // Step 1: Generate code via Llama 3.3 (Groq)
  setStatus('running', 'Generating solution with Llama 3.3...');
  const genRes = await msg({
    type: 'GENERATE_CODE',
    payload: { problem: currentProblem, language: langSelect.value }
  });

  if (genRes.error) {
    setStatus('error', 'Generation failed');
    showError(genRes.error);
    solveBtn.disabled  = false;
    scrapeBtn.disabled = false;
    return;
  }

  generatedCode  = genRes.code;
  codeContent.textContent = generatedCode;
  codeBlock.style.display = 'block';

  // Step 2: Type code into editor character by character
  const charCount = generatedCode.length;
  const estSecs   = Math.round((charCount * +speedSlider.value) / 1000);
  setStatus('running', `Typing ${charCount} chars (~${estSecs}s)...`);

  const typeRes = await msg({
    type: 'TYPE_CODE',
    payload: { code: generatedCode, typingSpeed: +speedSlider.value }
  });

  if (typeRes.error) {
    setStatus('error', 'Typing failed');
    showError(typeRes.error);
    solveBtn.disabled  = false;
    scrapeBtn.disabled = false;
    return;
  }

  // Step 3: Auto Run (if enabled)
  if (autoRunCheck.checked) {
    setStatus('running', 'Running code...');
    const runRes = await msg({
      type: 'RUN_CODE',
      payload: { autoNext: autoNextCheck.checked }
    });

    if (runRes.error) {
      setStatus('error', 'Run/Submit failed');
      showError(runRes.error);
      solveBtn.disabled  = false;
      scrapeBtn.disabled = false;
      return;
    }

    if (runRes.submitted && autoNextCheck.checked) {
      setStatus('done', '✓ Submitted! Moving to next problem...');
    } else if (runRes.submitted) {
      setStatus('done', '✓ Code typed, run & submitted!');
    } else {
      setStatus('done', '✓ Code typed & run! Submit manually if needed.');
    }
  } else {
    setStatus('done', '✓ Done! Code typed into editor.');
  }

  solveBtn.disabled  = false;
  scrapeBtn.disabled = false;
});

// --- Copy button ---
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
  statusDot.className   = `status-dot ${state}`;
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

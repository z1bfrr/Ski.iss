// content/scraper.js
// Injected into the SkillRack tab. Must return a plain serializable object.

(function scrapeProblem() {

  // ─── HELPER ────────────────────────────────────────────────────────
  const getText = (selector) => {
    const el = document.querySelector(selector);
    return el ? el.innerText.trim() : '';
  };

  // Check if an element is inside the CodeMirror editor (skip those)
  const isInsideEditor = (el) => !!el.closest('.CodeMirror, .cm-editor');

  // ─── TITLE ─────────────────────────────────────────────────────────
  // On codeprogram.xhtml the title is in a heading or tab label OUTSIDE the editor
  let title = '';

  // Words/phrases to skip — Semantic UI classes, navigation leftovers, SkillRack chrome
  const SKIP_EXACT = new Set([
    'ui button', 'ui buttons', 'ui label', 'ui input', 'ui menu', 'ui segment',
    'ui header', 'ui form', 'ui grid', 'ui card', 'ui item', 'ui list',
    'back', 'back to challenges list', 'submit', 'run', 'save', 'next', 'previous',
    'home', 'logout', 'login', 'settings', 'profile', 'dashboard',
    'code solution', 'view solution', 'check solution', 'mark as solved'
  ]);

  const headingCandidates = [...document.querySelectorAll('h1,h2,h3,h4,h5,label,span,div,p')];
  for (const el of headingCandidates) {
    if (isInsideEditor(el)) continue;
    const t = el.innerText?.trim();
    if (!t) continue;
    // Skip known non-title strings
    if (SKIP_EXACT.has(t.toLowerCase())) continue;
    // Skip: student name/ID, roll numbers, @ symbols
    if (t.includes('@')) continue;
    if (/\bR[-–]\d{4,}\b/i.test(t)) continue;
    if (/^\d/.test(t)) continue;                              // starts with digit = line number
    if (/^[A-Z][A-Z\s]{4,}$/.test(t) && t.split(' ').length <= 5) continue; // ALL-CAPS name
    // Must look like a problem title: single line, readable length, mostly letters, no code chars
    if (
      t.length > 8 && t.length < 200 &&
      !t.includes('\n') &&
      (t.match(/[a-zA-Z]/g) || []).length > t.length * 0.55 &&
      !t.match(/[{};#<>|\\]/) &&
      !/^\s*(ui|button|label|input|menu)\s*$/i.test(t)
    ) {
      title = t;
      break;
    }
  }

  // Smarter fallback: find text that looks like a problem name
  if (!title) {
    const allText = [...document.querySelectorAll('*')]
      .filter(el => !isInsideEditor(el) && el.children.length === 0)
      .map(el => el.innerText?.trim())
      .filter(t => t && t.length > 10 && t.length < 150 && /[A-Z]/.test(t) && !/[{};#<>]/.test(t));
    title = allText[0] || document.title;
  }

  // ─── PROBLEM STATEMENT ─────────────────────────────────────────────
  let statement = '';

  // Try known dedicated selectors first
  const knownStatementSelectors = [
    '.problem-statement', '#problem-statement', '#problemDesc',
    '.ques-desc', '.question-desc', '.problem-desc',
    'div[id*="desc"]', 'div[id*="problem"]', 'div[id*="question"]'
  ];
  for (const sel of knownStatementSelectors) {
    const el = document.querySelector(sel);
    if (el && !isInsideEditor(el)) {
      statement = el.innerText.trim();
      if (statement) break;
    }
  }

  // Fallback: scan all substantial text blocks, excluding the editor
  if (!statement) {
    const blockEls = [...document.querySelectorAll('div, td, p, section')].filter(el => {
      if (isInsideEditor(el)) return false;
      const t = el.innerText?.trim();
      if (!t || t.length < 60 || t.length > 8000) return false;
      if (el.children.length > 20) return false;
      // Must be mostly human-readable text (not code)
      const letters = (t.match(/[a-zA-Z ]/g) || []).length;
      const codeish = (t.match(/[{};#<>]/g) || []).length;
      return letters > codeish * 4;
    });
    // Sort by text length (longer = more likely to be the full statement)
    blockEls.sort((a, b) => b.innerText.length - a.innerText.length);
    statement = blockEls[0]?.innerText.trim() || '';
  }

  // ─── SAMPLE INPUT / OUTPUT ─────────────────────────────────────────
  let sampleInput = '', sampleOutput = '';

  // Walk the DOM for Input:/Output: labels OUTSIDE the editor
  const allLeafEls = [...document.querySelectorAll('*')].filter(el => {
    return !isInsideEditor(el) && el.children.length < 4;
  });

  for (const el of allLeafEls) {
    const txt = el.innerText?.trim().toLowerCase();
    if (!txt) continue;
    if ((txt === 'input:' || txt === 'input' || txt === 'sample input') && !sampleInput) {
      sampleInput = el.nextElementSibling?.innerText?.trim() ||
                    el.parentElement?.nextElementSibling?.innerText?.trim() || '';
    }
    if ((txt === 'output:' || txt === 'output' || txt === 'sample output') && !sampleOutput) {
      sampleOutput = el.nextElementSibling?.innerText?.trim() ||
                     el.parentElement?.nextElementSibling?.innerText?.trim() || '';
    }
  }

  // Regex fallback on visible page text (excluding editor via innerText of body)
  if (!sampleInput || !sampleOutput) {
    // Build text from only non-editor elements
    const cleanText = [...document.querySelectorAll('body *')]
      .filter(el => !isInsideEditor(el) && el.children.length === 0)
      .map(el => el.innerText?.trim())
      .filter(Boolean)
      .join('\n');

    if (!sampleInput) {
      const m = cleanText.match(/Input:\s*\n?([\s\S]*?)(?=Output:|Example\s+Input|$)/i);
      if (m) sampleInput = m[1].trim().substring(0, 300);
    }
    if (!sampleOutput) {
      const m = cleanText.match(/Output:\s*\n?([\s\S]*?)(?=Input:|Example|Explanation|Max Execution|$)/i);
      if (m) sampleOutput = m[1].trim().substring(0, 300);
    }
  }

  // ─── LANGUAGE DETECTION ────────────────────────────────────────────
  const langEl = document.querySelector(
    'select[name="language"], #language, select#langId, select[id*="lang"], select[id*="Language"]'
  );
  const detectedLanguage = langEl ? langEl.options[langEl.selectedIndex]?.text?.trim() : null;

  return {
    title,
    statement,
    constraints: '',
    sampleInput,
    sampleOutput,
    detectedLanguage,
    url: window.location.href
  };
})();

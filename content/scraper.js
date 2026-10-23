// content/scraper.js
// Injected into the SkillRack tab. Returns structured problem data.

(function scrapeProblem() {
  const isInsideEditor = (el) => !!el.closest('.ace_editor, .CodeMirror, .cm-editor, #editor, textarea');

  // Helper to extract clean visible text
  const cleanText = (str) => {
    return (str || '')
      .replace(/\r\n/g, '\n')
      .replace(/\u00a0/g, ' ')
      .trim();
  };

  // ─── 1. TITLE EXTRACTION ───────────────────────────────────────────
  let title = '';

  const skipTitles = new Set([
    'ui button', 'ui buttons', 'ui label', 'ui input', 'ui menu', 'ui segment',
    'ui header', 'ui form', 'ui grid', 'ui card', 'ui item', 'ui list',
    'back', 'back to challenges list', 'submit', 'run', 'save', 'next', 'previous',
    'home', 'logout', 'login', 'settings', 'profile', 'dashboard',
    'code solution', 'view solution', 'check solution', 'mark as solved',
    'skillrack', 'code test', 'programming test', 'test'
  ]);

  // Dedicated SkillRack / PrimeFaces title selectors
  const titleSelectors = [
    '.ui-panel-title',
    '#quesTitle',
    '.ques-title',
    '.question-title',
    'h2.header',
    'h3.header',
    '.header h2',
    '.header h3',
    'h2', 'h3', 'h4'
  ];

  for (const sel of titleSelectors) {
    const el = document.querySelector(sel);
    if (el && !isInsideEditor(el)) {
      const txt = cleanText(el.innerText);
      if (txt && txt.length >= 3 && txt.length < 150 && !skipTitles.has(txt.toLowerCase())) {
        title = txt;
        break;
      }
    }
  }

  // Fallback title detection
  if (!title) {
    const candidates = [...document.querySelectorAll('h1, h2, h3, h4, h5, span, b, strong, div')];
    for (const el of candidates) {
      if (isInsideEditor(el) || el.children.length > 2) continue;
      const t = cleanText(el.innerText);
      if (!t || skipTitles.has(t.toLowerCase())) continue;
      if (t.includes('@') || /^\d+$/.test(t) || /\bR[-–]\d{4,}\b/i.test(t)) continue;
      if (t.length >= 5 && t.length < 120 && !t.includes('\n') && /[a-zA-Z]/.test(t) && !/[{};#<>]/.test(t)) {
        title = t;
        break;
      }
    }
  }

  if (!title) {
    title = document.title.replace(/[-|].*$/, '').trim() || 'SkillRack Problem';
  }

  // ─── 2. PROBLEM CONTAINER EXTRACTION ───────────────────────────────
  // Find container that holds the problem text
  const problemContainerSelectors = [
    '#quesView',
    '#problemDesc',
    '.ques-desc',
    '.question-desc',
    '.problem-statement',
    '#problem-statement',
    '.ui-panel-content',
    'div[id*="question"]',
    'div[id*="problem"]',
    'div[id*="desc"]',
    'table.ui-panelgrid'
  ];

  let containerEl = null;
  for (const sel of problemContainerSelectors) {
    const el = document.querySelector(sel);
    if (el && !isInsideEditor(el)) {
      const txt = cleanText(el.innerText);
      if (txt.length > 50) {
        containerEl = el;
        break;
      }
    }
  }

  // Fallback to body scan if no container found
  const rootEl = containerEl || document.body;

  // ─── 3. EXTRACT FULL RAW CONTENT (excluding editor & chrome) ────────
  const pageText = cleanText(rootEl.innerText);

  // ─── 4. STRUCTURED SECTIONS PARSING ─────────────────────────────────
  let statement = '';
  let constraints = '';
  let inputFormat = '';
  let outputFormat = '';
  const examples = [];

  // Boundary condition / Constraints
  const constraintMatch = pageText.match(/(?:Boundary\s*Conditions?|Constraints?):\s*\n?([\s\S]*?)(?=(?:Input\s*Format|Output\s*Format|Example|Sample|\n\s*\n[A-Z][a-z]+:|$))/i);
  if (constraintMatch) {
    constraints = cleanText(constraintMatch[1]);
  }

  // Input Format
  const inputFormatMatch = pageText.match(/Input\s*Format:\s*\n?([\s\S]*?)(?=(?:Output\s*Format|Boundary|Constraints|Example|Sample|$))/i);
  if (inputFormatMatch) {
    inputFormat = cleanText(inputFormatMatch[1]);
  }

  // Output Format
  const outputFormatMatch = pageText.match(/Output\s*Format:\s*\n?([\s\S]*?)(?=(?:Boundary|Constraints|Example|Sample|Explanation|$))/i);
  if (outputFormatMatch) {
    outputFormat = cleanText(outputFormatMatch[1]);
  }

  // Examples / Samples extraction (supports multiple examples: Example 1, 2, 3...)
  const exampleRegex = /(?:Example|Sample)\s*(?:Input(?:\/|\s*and\s*)Output|\s*Test\s*Cases?|\s*Case)?\s*(\d*):?\s*([\s\S]*?)(?=(?:(?:Example|Sample)\s*(?:Input|\s*Test\s*Cases?|\s*Case|\d)|Explanation:|$))/gi;
  let exMatch;
  while ((exMatch = exampleRegex.exec(pageText)) !== null) {
    const exIndex = exMatch[1] || String(examples.length + 1);
    const exBody = exMatch[2];

    const inMatch = exBody.match(/(?:Input|Sample\s*Input):\s*\n?([\s\S]*?)(?=(?:Output|Sample\s*Output|Explanation|$))/i);
    const outMatch = exBody.match(/(?:Output|Sample\s*Output):\s*\n?([\s\S]*?)(?=(?:Explanation|Example|Sample|$))/i);

    if (inMatch || outMatch) {
      examples.push({
        index: exIndex,
        input: inMatch ? cleanText(inMatch[1]) : '',
        output: outMatch ? cleanText(outMatch[1]) : ''
      });
    }
  }

  // Simple Input / Output fallback if no Example numbered headings
  if (examples.length === 0) {
    const fallbackIn = pageText.match(/(?:Sample\s*Input|Input):\s*\n?([\s\S]*?)(?=(?:Sample\s*Output|Output|Explanation|$))/i);
    const fallbackOut = pageText.match(/(?:Sample\s*Output|Output):\s*\n?([\s\S]*?)(?=(?:Explanation|Example|$))/i);

    if (fallbackIn || fallbackOut) {
      examples.push({
        index: '1',
        input: fallbackIn ? cleanText(fallbackIn[1]) : '',
        output: fallbackOut ? cleanText(fallbackOut[1]) : ''
      });
    }
  }

  // Full statement: everything up to constraints or examples, or clean text
  const statementCutoff = pageText.search(/(?:Boundary\s*Conditions?|Constraints?:|Input\s*Format:|Example\s*Input|Sample\s*Input)/i);
  if (statementCutoff > 20) {
    statement = cleanText(pageText.substring(0, statementCutoff));
  } else {
    // Collect paragraphs
    const paragraphs = [...rootEl.querySelectorAll('p, div, td, pre')].filter(el => {
      if (isInsideEditor(el)) return false;
      const t = cleanText(el.innerText);
      return t.length > 40 && !t.includes('{') && !t.includes(';');
    });
    statement = paragraphs.map(p => cleanText(p.innerText)).slice(0, 4).join('\n\n') || pageText.slice(0, 1500);
  }

  // ─── 5. LANGUAGE DETECTION ─────────────────────────────────────────
  let detectedLanguage = null;

  // Check select elements (native or PrimeFaces)
  const langSelects = document.querySelectorAll(
    'select[name*="lang" i], select[id*="lang" i], select[name*="language" i], select#langId, .ui-selectonemenu'
  );

  for (const sel of langSelects) {
    if (sel.tagName === 'SELECT' && sel.selectedIndex >= 0) {
      const txt = sel.options[sel.selectedIndex]?.text?.trim();
      if (txt && /c\+\+|java|python|c\b/i.test(txt)) {
        detectedLanguage = txt;
        break;
      }
    } else if (sel.classList.contains('ui-selectonemenu')) {
      const label = sel.querySelector('.ui-selectonemenu-label');
      if (label && /c\+\+|java|python|c\b/i.test(label.innerText)) {
        detectedLanguage = label.innerText.trim();
        break;
      }
    }
  }

  // Normalize detected language string
  if (detectedLanguage) {
    if (/c\+\+/i.test(detectedLanguage)) detectedLanguage = 'C++';
    else if (/java/i.test(detectedLanguage)) detectedLanguage = 'Java';
    else if (/python/i.test(detectedLanguage)) detectedLanguage = 'Python 3';
    else if (/\bc\b/i.test(detectedLanguage)) detectedLanguage = 'C';
  }

  return {
    title,
    statement,
    constraints,
    inputFormat,
    outputFormat,
    examples,
    sampleInput: examples[0]?.input || '',
    sampleOutput: examples[0]?.output || '',
    rawContent: pageText.slice(0, 4000),
    detectedLanguage,
    url: window.location.href
  };
})();

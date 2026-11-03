#!/usr/bin/env node
/**
 * Multi-target sweep.
 *
 * Sends the same number-bearing sentences to every target language the model
 * claims to support and records how each one came back: fast, careful, or
 * fallback. A fallback is not automatically a failure — but a fallback whose
 * text still contains markup, or whose numbers changed, is.
 */

const BASE = process.env.BASE || 'http://127.0.0.1:8791';

const SENTENCES = [
  { en: 'The meeting starts at 3 PM.', why: '12h time' },
  { en: 'The train leaves at 7:45 AM.', why: 'clock time' },
  { en: 'I have 2 children.', why: 'count' },
];

const TARGETS = ['ko', 'ja', 'zh', 'es', 'fr', 'de', 'it', 'pt', 'nl', 'pl',
  'sv', 'da', 'fi', 'tr', 'ar', 'he', 'el', 'en'];

const MARKUP = /(\*\*|<\|[^>]*\|>|^\s*#{1,3}\s|Translation:|번역:)/m;

async function ask(text, target) {
  const res = await fetch(`${BASE}/api/translate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text, source: 'en', target }),
  });
  if (!res.ok) return { error: `HTTP ${res.status}` };
  return res.json();
}

function judge(out) {
  if (!out || out.error) return { verdict: 'ERROR', note: out?.error || '' };
  const t = out.translation || '';
  if (MARKUP.test(t)) return { verdict: 'LEAK', note: t.slice(0, 46).replace(/\n/g, ' ⏎ ') };
  if (out.mode === 'fallback') return { verdict: 'WEAK', note: t.slice(0, 46) };
  return { verdict: 'OK', note: t.slice(0, 46) };
}

(async () => {
  const rows = [];
  for (const target of TARGETS) {
    const cells = [];
    for (const s of SENTENCES) {
      const out = await ask(s.en, target);
      cells.push({ ...judge(out), mode: out?.mode, why: s.why });
    }
    rows.push({ target, cells });
    const line = cells.map((c) => c.verdict.padEnd(6)).join('');
    const bad = cells.filter((c) => c.verdict !== 'OK').map((c) => `${c.why}:${c.verdict}`);
    console.log(`${target.padEnd(3)} ${line} ${bad.join(' ') || ''}`);
  }

  const total = rows.length * SENTENCES.length;
  const ok = rows.flatMap((r) => r.cells).filter((c) => c.verdict === 'OK').length;
  const leak = rows.flatMap((r) => r.cells).filter((c) => c.verdict === 'LEAK').length;
  console.log(`\nOK ${ok}/${total}   leaks ${leak}`);

  console.log('\n--- non-OK detail ---');
  for (const r of rows) {
    for (const c of r.cells) {
      if (c.verdict !== 'OK') console.log(`${r.target.padEnd(3)} ${c.why.padEnd(11)} ${c.verdict.padEnd(6)} [${c.mode}] ${c.note}`);
    }
  }
})();

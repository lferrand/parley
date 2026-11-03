/**
 * Clock-time canonicalisation for the translation guard.
 *
 * "3 PM" is written 15h in French, 15 Uhr in German, 15:00 in Italian,
 * 오후 3시 in Korean, 午後3時 in Japanese and kl. 15 in Danish. All correct,
 * none sharing a digit with the source. Comparing glyphs reads each as a lost
 * number, rejects a good translation, then burns the 2-3 s retry loop and falls
 * back anyway.
 *
 * So compare *moments*: every clock mention becomes minutes since midnight.
 *
 * One scanner produces both the set of moments and the text with those spans
 * blanked out. Detection and stripping therefore cannot disagree about which
 * forms exist — a class of bug this file exists to avoid.
 */

const MERIDIEM = new Map([
  ['오전', 'am'], ['오후', 'pm'],        // Korean
  ['午前', 'am'], ['午後', 'pm'],        // Japanese
  ['上午', 'am'], ['下午', 'pm'],        // Chinese
  ['ص', 'am'], ['م', 'pm'],              // Arabic (best effort)
]);

/** hour in 24h form from a 12h hour + meridiem */
function to24(hour, meridiem) {
  const h = hour % 12;
  return meridiem === 'pm' ? h + 12 : h;
}

const MER = '(오전|오후|오전|午前|午後|上午|下午)';

/**
 * Ordered passes. Each blanks out what it matched so later passes cannot
 * double-count the same span.
 */
const PASSES = [
  // Eastern meridiem with a clock suffix: 오후 3시 30분 / 午後3時 / 下午3点
  {
    re: new RegExp(`${MER}\\s*(\\d{1,2})(?:\\s*[:.]\\s*(\\d{2}))?\\s*(?:시|時|点|點)(?:\\s*(\\d{1,2}))?\\s*분?`, 'g'),
    take: (m) => {
      const mer = MERIDIEM.get(m[1]) || 'am';
      const hour = to24(Number(m[2]), mer);
      const mins = m[3] ?? m[4];
      return hour * 60 + (mins ? Number(mins) : 0);
    },
  },
  // 3 PM / 7:45 am / 3p.m.
  {
    re: /(\d{1,2})(?:[:.](\d{2}))?\s*(a\.?m\.?|p\.?m\.?)(?![a-z])/gi,
    take: (m) => to24(Number(m[1]), /^p/i.test(m[3]) ? 'pm' : 'am') * 60 + (m[2] ? Number(m[2]) : 0),
  },
  // Arabic spells the meridiem out rather than abbreviating it:
  // "الساعة 3 مساءً" (3 in the evening = 3 PM). Without this pass the moment
  // was invisible to the scanner, so a correct Arabic line was rejected.
  {
    re: /(\d{1,2})(?:[:.](\d{2}))?\s*(مساءً|مساء|صباحاً|صباح|ظهراً|ظهر|ليلاً|ليلة)/g,
    take: (m) => {
      const evening = /^(مساء|ظهر|ليل)/.test(m[3]);
      return to24(Number(m[1]), evening ? 'pm' : 'am') * 60 + (m[2] ? Number(m[2]) : 0);
    },
  },
  // French puts the minutes after the h: 7h45, 15h30. This must run before the
  // bare "15h" pass, which would otherwise capture the hour alone and lose the
  // minutes — "7h45" read as 7:00.
  {
    re: /(?<!\d)(\d{1,2})\s*h\s*(\d{2})(?!\d)/gi,
    take: (m) => (Number(m[1]) % 24) * 60 + Number(m[2]),
  },
  // 15h / 15 Uhr / 15 uur
  {
    re: /(\d{1,2})(?:[:.](\d{2}))?\s*(?:h(?![a-z])|uhr\b|uur\b)/gi,
    take: (m) => (Number(m[1]) % 24) * 60 + (m[2] ? Number(m[2]) : 0),
  },
  // Scandinavian "kl. 15" / "kl 15.30"
  {
    re: /\bkl\.?\s*(\d{1,2})(?:[:.](\d{2}))?/gi,
    take: (m) => (Number(m[1]) % 24) * 60 + (m[2] ? Number(m[2]) : 0),
  },
  // Bare H:MM — the usual 24-hour form, and must run last so "3:30 PM"
  // is already gone before it could be read as a bare time.
  {
    re: /(?<!\d)(\d{1,2}):(\d{2})(?!\d)/g,
    take: (m) => (Number(m[1]) % 24) * 60 + Number(m[2]),
  },
];

/** @returns {{minutes: Set<number>, rest: string}} */
export function scanTimes(text) {
  let rest = String(text || '');
  const minutes = new Set();

  for (const { re, take } of PASSES) {
    rest = rest.replace(re, (...args) => {
      const value = take(args);
      if (Number.isFinite(value)) minutes.add(value);
      // Blank the span, preserving length so nothing else shifts.
      return ' '.repeat(args[0].length);
    });
  }

  return { minutes, rest };
}

/** Every clock moment named in `text`, as minutes since midnight. */
export function timeMentions(text) {
  return scanTimes(text).minutes;
}

/** The same text with every clock mention removed. */
export function stripTimes(text) {
  return scanTimes(text).rest;
}

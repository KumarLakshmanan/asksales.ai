/** Parse explicit customer dates without relying on a model to normalize them.
 * Ambiguous numeric dates and vague phrases deliberately remain uncollected. */
export function parseJourneyDate(text: string, fieldKey: string, allowUnlabelled: boolean, now = new Date()): string | undefined {
  const today = new Intl.DateTimeFormat('en-CA', {
    timeZone: process.env.TZ || 'UTC', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(now);
  const year = Number(today.slice(0, 4));
  const months = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
  const month = '(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)';
  // Leave shared-month ranges to the keyed range extractor rather than
  // accidentally treating only the last date as both endpoints.
  if (/\b\d{1,2}(?:st|nd|rd|th)?\s*(?:to|–|-)\s*\d{1,2}(?:st|nd|rd|th)?\s+[a-z]/i.test(text)) return undefined;
  const pattern = new RegExp(`\\b(?:\\d{4}-\\d{2}-\\d{2}|\\d{1,2}(?:st|nd|rd|th)?\\s*${month}(?:[ ,]+\\d{4})?|${month}\\s+\\d{1,2}(?:st|nd|rd|th)?(?:[ ,]+\\d{4})?|day\\s+after\\s+tomorrow|tomorrow|today)\\b`, 'gi');
  const labels = [...text.matchAll(/\bcheck[\s-]*(in|out)\b/gi)];
  const wanted = /checkIn$/i.test(fieldKey) ? 'in' : /checkOut$/i.test(fieldKey) ? 'out' : null;
  const matches = [...text.matchAll(pattern)];
  const dates = matches.filter(match => {
    if (!wanted || !labels.length) return allowUnlabelled;
    // An answer to the pending date may precede a separate labelled clause:
    // "18 November, and we check out on 20 November". Do not let that later
    // checkout label steal the first date. Require a clause boundary and a
    // second date after the label; otherwise preserve the ambiguity checks.
    const first = labels[0];
    if (match.index! + match[0].length < first.index!
      && /[,;]|\band\b/i.test(text.slice(match.index! + match[0].length, first.index!))
      && matches.some(candidate => candidate.index! > first.index!)) {
      return allowUnlabelled && first[1].toLowerCase() !== wanted;
    }
    const previous = labels.filter(label => label.index! < match.index!).at(-1);
    if (previous && /^(?:\s|[:=,-]|date|is|on|will|be|b|the|at|from|to)*$/i.test(
      text.slice(previous.index! + previous[0].length, match.index!))) {
      return previous[1].toLowerCase() === wanted;
    }
    const nearest = labels.map(label => ({ label, distance: label.index! < match.index!
      ? match.index! - (label.index! + label[0].length)
      : label.index! - (match.index! + match[0].length) }))
      .sort((a, b) => a.distance - b.distance || a.label.index! - b.label.index!)[0];
    return nearest.label[1].toLowerCase() === wanted;
  });
  if (dates.length !== 1) return undefined;
  const value = dates[0][0].toLowerCase();
  if (/^(?:today|tomorrow|day\s+after\s+tomorrow)$/.test(value)) {
    const date = new Date(`${today}T12:00:00Z`);
    date.setUTCDate(date.getUTCDate() + (value === 'today' ? 0 : value === 'tomorrow' ? 1 : 2));
    return date.toISOString().slice(0, 10);
  }
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return value;
  const monthName = value.match(new RegExp(month, 'i'))![0];
  const monthNumber = months.indexOf(monthName.slice(0, 3)) + 1;
  const day = Number(value.match(/\d{1,2}(?:st|nd|rd|th)?/)![0].replace(/\D/g, ''));
  const explicitYear = value.match(/\b\d{4}\b/)?.[0];
  const formatted = (y: number) => `${y}-${String(monthNumber).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
  let result = formatted(explicitYear ? Number(explicitYear) : year);
  if (!explicitYear && result < today) result = formatted(year + 1);
  const parsed = new Date(`${result}T12:00:00Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === result ? result : undefined;
}

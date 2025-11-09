function collapseWhitespace(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

export function scrubField(value) {
  let text = collapseWhitespace(value);
  if (!text) return '';

  text = text.replace(/\bHSN\s*:?\s*\d{4,}\b/gi, '');
  text = text.replace(/\bGST\s*:?\s*\d{1,2}%/gi, '');
  text = text.replace(/\bGST\s*\d{1,2}(?:\.\d+)?%/gi, '');
  text = text.replace(/\bHSN\b/gi, '');

  text = text.replace(/(?:\b(?:INR|MRP|LP|List|Price)\b.*)$/i, '');
  text = text.replace(/\b20\d{2}\b.*$/i, '');

  text = text.replace(/[|,:]+$/g, '');
  text = text.replace(/\s{2,}/g, ' ');
  return collapseWhitespace(text);
}

// The narrator's checks were written for a model that is already fluent, so a
// student is also held to whole words: no unknown pieces, no word twice running,
// no three-word phrase said twice, no number run into a word.
export function fluency(text) {
  if (/<unk>/.test(text)) return 'unknown word';
  if (/\b(\w+) \1\b/i.test(text)) return 'word repeated';
  const w = text.toLowerCase().match(/[a-z0-9']+/g) ?? [];
  const seen = new Set();
  for (let i = 0; i + 3 <= w.length; i++) {
    const g = w.slice(i, i + 3).join(' ');
    if (seen.has(g)) return 'phrase repeated';
    seen.add(g);
  }
  if (/[a-z]\d|\d[a-z]/i.test(text.replace(/\d+(st|nd|rd|th)\b/gi, ''))) return 'number run into a word';
  return null;
}

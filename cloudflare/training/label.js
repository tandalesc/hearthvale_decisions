// Teacher labels for a learning job's rows, in batches: questions that share a town state go
// in one request (up to MAX_QUESTIONS_PER_REQUEST), a few requests at a time. One request per
// question, one after another, could outlast the job's 90-minute lease (job 0c4a3029, 621 rows).
// Each question is still asked at most once: no retries, and a failed request loses only its own
// questions, which the job then trains without.
//
//   labelRows(rows, {teacher, ask, valid}) -> {rows, labels} (the rows with a valid label, in order)
//   ask(state, questions) -> {answers: {id: {probabilities}}, model}   one request, may throw
//   valid(row, label) -> whether a label is usable for that row
import {MAX_QUESTIONS_PER_REQUEST, canonicalJson} from '../../src/decision-kinds.js';
import {FEATURES_VERSION} from '../../src/decision-features.js';

export async function labelRows(rows, {teacher, ask, valid, batch = MAX_QUESTIONS_PER_REQUEST, concurrency = 4}) {
  const labels = rows.map((row) => row.label);
  const needs = rows.map((row, i) => i).filter((i) => {
    const l = labels[i];
    return l?.model !== teacher || l?.features !== FEATURES_VERSION || !valid(rows[i], l);
  });
  // Chunks of rows sharing a state, at most `batch` questions each.
  const byState = new Map();
  for (const i of needs) {
    const key = canonicalJson(rows[i].state ?? {});
    if (!byState.has(key)) byState.set(key, []);
    byState.get(key).push(i);
  }
  const chunks = [];
  for (const list of byState.values()) for (let s = 0; s < list.length; s += batch) chunks.push(list.slice(s, s + batch));
  for (const i of needs) labels[i] = null;
  let next = 0;
  async function worker() {
    while (next < chunks.length) {
      const chunk = chunks[next++];
      const questions = chunk.map((i, n) => {
        const row = rows[i];
        return {id: `q${n}`, kind: row.kind, context: row.context, ...(row.allowed ? {allowed: row.allowed} : {})};
      });
      try {
        const answer = await ask(rows[chunk[0]].state, questions);
        chunk.forEach((i, n) => {
          const probabilities = answer.answers?.[`q${n}`]?.probabilities;
          if (probabilities) labels[i] = {key: rows[i].key, kind: rows[i].kind, probabilities, model: answer.model, features: FEATURES_VERSION};
        });
      } catch {
        // This request's questions go unlabelled; the job continues with the rest.
      }
    }
  }
  await Promise.all(Array.from({length: Math.min(concurrency, chunks.length)}, worker));
  const out = {rows: [], labels: [], requests: chunks.length};
  rows.forEach((row, i) => {
    if (labels[i] && valid(row, labels[i])) { out.rows.push(row); out.labels.push(labels[i]); }
  });
  return out;
}

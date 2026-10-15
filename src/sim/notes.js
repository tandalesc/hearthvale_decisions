// Inspector notes, cached in the save until something meaningful changes. Written by
// the narrator; purely cosmetic, the simulation never reads them.
//
//   setEntityNote(state, 'household:7', {key, text}) -> {ok} | {ok: false, error}
//   touchEntityNote(state, 'household:7')            -> {ok}   (marks it recently seen)
// At most 300 notes are kept; the least recently seen goes first.

const REF = /^(person|household|building|body):[A-Za-z0-9_-]{1,40}$/;
const MAX_NOTES = 300;
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f]/g;

export function setEntityNote(state, ref, {key, text} = {}) {
  if (typeof ref !== 'string' || !REF.test(ref)) return {ok: false, error: 'bad ref'};
  if (typeof key !== 'string' || typeof text !== 'string') return {ok: false, error: 'key and text must be strings'};
  state.notes ??= {};
  state.notes[ref] = {
    key: key.replace(CONTROL, '').slice(0, 40),
    text: text.replace(CONTROL, '').slice(0, 600),
    year: state.time.year,
    month: state.time.month,
    seen: (state.notesSeq = (state.notesSeq ?? 0) + 1),
  };
  trim(state.notes);
  return {ok: true};
}

export function touchEntityNote(state, ref) {
  const note = state.notes?.[ref];
  if (note) note.seen = state.notesSeq = (state.notesSeq ?? 0) + 1;
  return {ok: true};
}

function trim(notes) {
  let refs = Object.keys(notes);
  while (refs.length > MAX_NOTES) {
    let oldest = refs[0];
    for (const r of refs) if (notes[r].seen < notes[oldest].seen) oldest = r;
    delete notes[oldest];
    refs = Object.keys(notes);
  }
}

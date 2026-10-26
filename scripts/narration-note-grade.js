// The grader for inspector notes (scripts/narration-note-judge.js, scripts/narration-note-verdicts.js):
// Haiku grades one note on its facts, blind to who wrote it.
import {noteMessage} from '../cloudflare/narration.js';

export const MODEL = 'claude-haiku-5-5';
export const SYSTEM = `You grade one short note from a town-building game. Tapping a person, household, building or town body shows a note about it, written from the facts below.
Grade only this note, not whether you would have written it differently.
Return only JSON: {"grammar": "clean" | "minor" | "broken", "contradiction": true | false, "claim": "...", "specific": true | false}
- grammar: "clean" reads naturally; "minor" has a small slip a reader glides over; "broken" has a sentence a reader stumbles on.
- contradiction: true only if the note states something a fact line says is otherwise, or contradicts itself. Leaving a fact out is not a contradiction. "Needs: energy high" means they badly need rest (they are tired); "Needs: food high" means they are hungry; "Needs: company high" means they are lonely.
- claim: when contradiction is true, the note's words that are wrong, copied exactly; else "".
- specific: true if it tells the reader something particular about this one (their situation, mood, work, what happened to them); false if it could be said of almost any of its kind.`;
export const prompt = (facts, text) => `Facts:\n${noteMessage(facts)}\n\nNote: "${text}"\n\nReturn the JSON.`;

// One grade: {grammar, contradiction, claim, specific, tokens: {input, output}}; throws on a bad reply.
export async function grade(client, facts, text) {
  const msg = await client.messages.create({model: MODEL, max_tokens: 160, thinking: {type: 'disabled'},
    system: [{type: 'text', text: SYSTEM}], messages: [{role: 'user', content: prompt(facts, text)}]});
  const reply = msg.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
  return {...JSON.parse(reply.slice(reply.indexOf('{'), reply.lastIndexOf('}') + 1)), tokens: {input: msg.usage.input_tokens, output: msg.usage.output_tokens}};
}

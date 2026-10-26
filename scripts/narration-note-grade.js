// The grader for inspector notes (scripts/narration-note-judge.js, scripts/narration-note-verdicts.js):
// Haiku grades one note on its facts, blind to who wrote it.
import {noteMessage} from '../cloudflare/narration.js';

export const MODEL = 'claude-haiku-5-5';
export const SYSTEM = `You grade one short note from a town-building game. Tapping a person, household, building or town body shows a note about it, written from the facts below.
Grade only this note, not whether you would have written it differently.
Return only JSON: {"grammar": "clean" | "minor" | "broken", "contradiction": true | false, "claim": "...", "specific": true | false}
- grammar: "clean" reads naturally; "minor" has a small slip a reader glides over; "broken" has a sentence a reader stumbles on.
- contradiction: true only if the note states something a fact line says is otherwise, or contradicts itself. Leaving a fact out is not a contradiction. In older fact sheets "Needs: energy high" means they are full of energy, "food high" well fed, "company high" in good company; "low" is tired, hungry, lonely.
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

// A second rubric: how good a note this is for a player who tapped the entity, 1 to 5.
export const QUALITY_SYSTEM = `You grade one short note from a town-building game. Tapping a person, household, building or town body shows a note about it, written from the facts below. Judge it as the player reading it.
Return only JSON: {"score": 1 | 2 | 3 | 4 | 5, "why": "at most 12 words"}
- 5: tells the player something particular and worth knowing about this one (their situation, work, mood and its cause, what happened to them or the building), in natural words, no filler.
- 4: good and pertinent, with a small weakness (a little generic, a slightly awkward phrase).
- 3: correct but bland: mostly filler or small talk ("spring has come", "I'm glad to be here"), or says what any of its kind would.
- 2: repeats itself, rambles, reads awkwardly, or gets a fact plainly wrong.
- 1: broken, nonsensical, or mostly wrong.
In older fact sheets "Needs: energy high" means they are full of energy, "food high" well fed, "company high" in good company; "low" is tired, hungry, lonely.`;
export const qualityPrompt = (facts, text) => `Facts:\n${noteMessage(facts)}\n\nNote: "${text}"\n\nReturn the JSON.`;
export async function gradeQuality(client, facts, text) {
  const msg = await client.messages.create({model: MODEL, max_tokens: 200, thinking: {type: 'disabled'},
    system: [{type: 'text', text: QUALITY_SYSTEM}], messages: [{role: 'user', content: qualityPrompt(facts, text)}]});
  const reply = msg.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
  return {...JSON.parse(reply.slice(reply.indexOf('{'), reply.lastIndexOf('}') + 1)), tokens: {input: msg.usage.input_tokens, output: msg.usage.output_tokens}};
}

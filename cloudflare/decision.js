import {MAX_QUESTIONS_PER_REQUEST,MAX_GROUPS_PER_REQUEST,validateQuestion,validateState,renderQuestion,normalizeAnswer} from '../src/decision-kinds.js';
export function validateDecisionRequest(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some(k => k !== 'groups')) throw new Error('Invalid decision request');
  const {groups} = body;
  if (!Array.isArray(groups) || groups.length < 1 || groups.length > MAX_GROUPS_PER_REQUEST) throw new Error('Invalid group count');
  const ids = new Set();
  let total = 0;
  const clean = groups.map(group => {
    if (!group || typeof group !== 'object' || Array.isArray(group) || Object.keys(group).some(k => k !== 'state' && k !== 'questions')) throw new Error('Invalid group');
    if (!Array.isArray(group.questions) || group.questions.length < 1) throw new Error('Invalid group questions');
    total += group.questions.length;
    if (total > MAX_QUESTIONS_PER_REQUEST) throw new Error('Too many questions');
    const questions = group.questions.map(q => {
      const question = validateQuestion(q);
      if (ids.has(question.id)) throw new Error('Duplicate question id');
      ids.add(question.id);
      return question;
    });
    let state;
    for (const kind of new Set(questions.map(q => q.kind))) state = validateState(kind, group.state);
    return {state, questions};
  });
  return clean;
}

// Upstream keys are positional so client ids never reach the model.
const upstreamKey = (q, index) => `${q.kind}_${index}`;

function upstreamGroup({state, questions}) {
  const body = {questions: Object.fromEntries(questions.map((q, i) => [upstreamKey(q, i), renderQuestion(q, state)]))};
  // Always send a state: the service now answers 413 ("state too large") when
  // the field is missing or null, even for tiny requests. An empty {} is fine.
  body.state = state && typeof state === 'object' ? state : {};
  return body;
}

// One state -> the /v1/decisions body; several -> the /v1/decisions/batch body.
export function buildDecisionPayload(groups) {
  return groups.length === 1 ? upstreamGroup(groups[0]) : {requests: groups.map(upstreamGroup)};
}

const modelName = data => typeof data?.model === 'string' && /^[a-zA-Z0-9_./-]{1,100}$/.test(data.model) ? data.model : 'local-decision-service';

// Normalize one group's raw answers into `into` (keyed by client id).
function collect(group, rawAnswers, into) {
  let count = 0;
  if (!rawAnswers || typeof rawAnswers !== 'object') return 0;
  group.questions.forEach((q, i) => {
    const answer = normalizeAnswer(q, rawAnswers[upstreamKey(q, i)]);
    if (answer) { into[q.id] = answer; count++; }
  });
  return count;
}

export function parseDecisionAnswers(data, groups) {
  if (!data || typeof data !== 'object') throw new Error('Invalid answer envelope');
  const answers = {};
  if (groups.length === 1) {
    if (typeof data.answers !== 'object' || data.answers === null) throw new Error('Invalid answer envelope');
    collect(groups[0], data.answers, answers);
  } else {
    if (!Array.isArray(data.results) || data.results.length !== groups.length) throw new Error('Invalid batch envelope');
    groups.forEach((group, i) => collect(group, data.results[i]?.answers, answers));
  }
  if (!Object.keys(answers).length) throw new Error('No valid answers');
  return {answers, model: modelName(data)};
}


export async function hostedDecisions(env,groups,readText) {
 const answers={};
 for (const group of groups) {
  const response=await fetch('https://api.liquid.ai/decisions/v1/systemone',{method:'POST',headers:{Authorization:`Bearer ${env.LIQUID_API_KEY}`,'Content-Type':'application/json'},body:JSON.stringify({model:'d1',...buildDecisionPayload([group])}),signal:AbortSignal.timeout(15000),redirect:'manual'});
  if(!response.ok) { await response.body?.cancel(); throw new Error('Decision provider unavailable'); }
  Object.assign(answers,parseDecisionAnswers(JSON.parse(await readText(response,262144)),[group]).answers);
 }
 return {answers,model:'d1',source:'hosted-teacher'};
}

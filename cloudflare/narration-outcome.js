// Only fixed categories and timings may enter production logs. Diagnostics can
// contain generated text, so never spread or stringify their contents here.
const CATEGORIES=new Map([
 ['invalid JSON','invalid_json'],['missing why','missing_text'],['more than 40 words','too_long'],
 ['speaks of themselves by name','speaker_name'],['restates the template','template_repetition'],
 ['copies a template sentence','template_repetition'],['copies an example card','example_repetition'],
 ['no concrete detail','missing_detail'],['number not in facts','unsupported_number'],
 ['name not in facts','unsupported_name'],['overstates','overstatement'],['stiff phrasing','style'],
 ['claims your rulings as theirs','ruling_ownership'],['unfinished','unfinished'],['too long','too_long'],
 ['too many words','too_long'],['too many sentences','too_long'],
 ['omits a competing plan','missing_plan'],['unchanged game explanation','template_repetition'],
]);
export function rejectionCategory(diagnostic) {
 const reason=diagnostic?.checked?.reasons?.why??diagnostic?.checked?.reason;
 return typeof reason==='string'?(CATEGORIES.get(reason.split(':')[0].trim())||'validation'):undefined;
}
export function logNarrationOutcome(source,started,{firstPreviewMs,category}={}) {
 const record={event:'narration_result',source:['llm','template','error','cache'].includes(source)?source:'error',durationMs:Math.max(0,Date.now()-started)};
 if(Number.isFinite(firstPreviewMs)&&firstPreviewMs>=0)record.firstPreviewMs=Math.round(firstPreviewMs);
 if(category)record.category=new Set([...CATEGORIES.values(),'validation','aborted','timeout','provider']).has(category)?category:'validation';
 console.info(JSON.stringify(record));
}
export async function observeNarration({run,onPreview,signal}) {
 const started=Date.now();let firstPreviewMs,category;
 try {
  const value=await run({signal,onPreview:async snapshot=>{firstPreviewMs??=Date.now()-started;await onPreview?.(snapshot);},onDiagnostic:diagnostic=>{category=rejectionCategory(diagnostic)??category;}});
  const source=value.source==='template'?'template':'llm';
  logNarrationOutcome(source,started,{firstPreviewMs,...(source==='template'?{category:category||'validation'}:{})});return value;
 } catch(error) {
  logNarrationOutcome('error',started,{firstPreviewMs,category:signal?.aborted?'aborted':error.name==='AbortError'?'timeout':'provider'});throw error;
 }
}

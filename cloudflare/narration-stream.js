const encoder=new TextEncoder();
// Await every write: the provider cannot outrun the downstream reader. A wrapped
// reader propagates disconnects even while the provider is awaiting its next token.
export function narrationStream({request,ctx,headers={},cached,run,onComplete}) {
 const aborter=new AbortController(),transport=new TransformStream();
 const writer=transport.writable.getWriter(),reader=transport.readable.getReader();
 const abort=()=>{if(!aborter.signal.aborted)aborter.abort();void writer.abort(new Error('Narration cancelled')).catch(()=>{});};
 request.signal.addEventListener('abort',abort,{once:true});if(request.signal.aborted)abort();
 const timer=setTimeout(abort,16000);
 // workerd notices a quiet HTTP disconnect on the next body write. Keep one
 // bounded heartbeat outstanding so a stalled provider is cancelled promptly.
 let heartbeatPending=false;
 const heartbeat=setInterval(()=>{if(heartbeatPending||aborter.signal.aborted)return;heartbeatPending=true;writer.write(encoder.encode(': keep-alive\n\n')).catch(abort).finally(()=>{heartbeatPending=false;});},1000);
 let previews=0;
 const event=async(name,value)=>{
  if(aborter.signal.aborted)throw new Error('Narration cancelled');
  const text=`event: ${name}\ndata: ${JSON.stringify(value)}\n\n`;
  if(encoder.encode(text).byteLength>16384)throw new Error('Narration event too large');
  await writer.write(encoder.encode(text));
 };
 const work=(async()=>{
  try {
   await event('meta',{source:cached?'cache':'llm',cached:Boolean(cached)});
   const value=cached||await run({signal:aborter.signal,onPreview:async snapshot=>{
    if(++previews>8||!snapshot||!['why','text'].includes(snapshot.field)||typeof snapshot.text!=='string'||snapshot.text.length>420)throw new Error('Invalid narration preview');
    await event('delta',{t:snapshot.text,replace:true,field:snapshot.field});
   }});
   if(aborter.signal.aborted)return;
   if(!cached)await onComplete?.(value);
   await event('done',value);
   await writer.close();
  } catch {
   if(!aborter.signal.aborted) {
    // The client discards drafts and restores its canonical text on failure.
    try{await event('error',{error:'Narration unavailable',fallback:true});await writer.close();}catch{}
   }
   if(!aborter.signal.aborted)aborter.abort();
  } finally {clearTimeout(timer);clearInterval(heartbeat);request.signal.removeEventListener('abort',abort);}
 })();
 ctx.waitUntil(work);
 const body=new ReadableStream({
  async pull(controller){try{const next=await reader.read();if(next.done)controller.close();else controller.enqueue(next.value);}catch(error){controller.error(error);}},
  async cancel(reason){abort();await reader.cancel(reason).catch(()=>{});},
 },{highWaterMark:0});
 return new Response(body,{headers:{'Content-Type':'text/event-stream; charset=utf-8','Cache-Control':'no-store, no-transform','X-Content-Type-Options':'nosniff',...headers}});
}

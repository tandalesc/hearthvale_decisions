// CompressionStream deflates on its calling thread. Keep that work away from
// animation frames; the Blob is the immutable snapshot the save store took.
self.onmessage = async ({data: source}) => {
  try {
    const stream = source.stream().pipeThrough(new CompressionStream('gzip'));
    const bytes = await new Response(stream).arrayBuffer();
    self.postMessage({blob: new Blob([bytes], {type: 'application/gzip'})});
  } catch (error) {
    self.postMessage({error: error.message});
  }
};

// Runs src/sim-worker.js in a Node worker thread: gives it the `self` a browser worker has.
import {parentPort} from 'node:worker_threads';

globalThis.self = globalThis;
globalThis.postMessage = (msg, transfer) => parentPort.postMessage(msg, transfer);
parentPort.on('message', (data) => globalThis.onmessage?.({data}));
await import('../src/sim-worker.js');

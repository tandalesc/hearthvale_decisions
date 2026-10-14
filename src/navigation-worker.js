import {RouteScheduler} from './navigation.js';
const scheduler=new RouteScheduler();let state=null,running=false;
function pump(){scheduler.tick(6,128);if(scheduler.pending)setTimeout(pump,0);else running=false;}
self.onmessage=({data})=>{if(data.type==='reset'){state=data.state;scheduler.reset(state);return;}if(data.type==='route'&&state){const accepted=scheduler.request(state,data.start,data.goal,route=>postMessage({id:data.id,revision:data.revision,route,stats:scheduler.stats}));if(!accepted)postMessage({id:data.id,revision:data.revision,route:null});if(!running){running=true;setTimeout(pump,0);}}};

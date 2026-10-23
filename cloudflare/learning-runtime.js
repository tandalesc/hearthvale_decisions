// Cloudflare RPC entrypoints; pure coordinator/container logic remains importable in Node tests.
import {DurableObject} from 'cloudflare:workers';
import {LearningCoordinator as CoordinatorCore, LearningContainer as ContainerCore} from './learning.js';
export class LearningCoordinator extends DurableObject {
  constructor(ctx, env) { super(ctx, env); this.core = new CoordinatorCore(ctx, env); }
  fetch(request) { return this.core.fetch(request); }
  alarm() { return this.core.alarm(); }
  ingest(report) { return this.core.ingest(report); }
  labels(report) { return this.core.labels(report); }
  manifest() { return this.core.manifest(); }
  status() { return this.core.status(); }
  trigger() { return this.core.trigger(); }
  scheduled() { return this.core.scheduled(); }
}
export class LearningContainer extends DurableObject {
  constructor(ctx, env) { super(ctx, env); this.core = new ContainerCore(ctx, env); }
  startJob(job) { return this.core.startJob(job); }
  stopJob() { return this.core.stopJob(); }
}

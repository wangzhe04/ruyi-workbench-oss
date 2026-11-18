'use strict';
// Research-only process-retention primitive. A child is issued immediately
// after spawn and remains strongly held until the actual close event is observed.
const issued = new Set(), retainedOwners = new Map();
function retainIssued(child, owner) {
  if (!child || typeof child.once !== 'function' || !owner) throw Error('issued.invalid');
  if (issued.has(child)) throw Error('issued.duplicate');
  issued.add(child);
  if (!retainedOwners.has(owner)) retainedOwners.set(owner, new Set());
  const children = retainedOwners.get(owner); children.add(child);
  child.once('close', () => { issued.delete(child); children.delete(child); });
  return child;
}
// Owner release is explicit after its other leases and all issued children have
// been observed. An error event or a PID query is not a close event.
function releaseOwner(owner) {
  const children = retainedOwners.get(owner);
  if (!children || children.size) throw Error('issued.still_running');
  retainedOwners.delete(owner);
}
function stats() { return Object.freeze({issued:issued.size, retainedOwners:retainedOwners.size}); }
module.exports = {retainIssued, releaseOwner, stats};

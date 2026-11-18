'use strict';
// Temporary routing signal only; never alter model or source inputs.
function signal(text) {
  return text.replace(/```[\s\S]*?(?:```|$)/g,' ')
    .replace(/`[^`]*(?:`|$)/g,' ')
    .replace(/\b(?:https?:\/\/|www\.)[^\s]+/giu,' ')
    .replace(/\b[\p{L}\p{N}._%+-]+@[\p{L}\p{N}.-]+\.[\p{L}]{2,}\b/gu,' ')
    .replace(/\S*[\\/]\S*/g,' ')
    .replace(/\b[A-Za-z0-9_-]*\d[A-Za-z0-9_-]*\b/g, token => /[A-Za-z_-]/.test(token) ? ' ' : token);
}
function route(text) {
  const s=signal(text), han=/\p{Script=Han}/u.test(s), latin=/\p{Script=Latin}{2,}/u.test(s);
  return han ? (latin?'mixed':'zh') : (latin?'en':'unknown');
}
module.exports={signal,route};

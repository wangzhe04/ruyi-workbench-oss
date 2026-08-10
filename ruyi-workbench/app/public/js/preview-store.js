'use strict';

export const PREVIEW_UI_STATE_STORAGE_KEY = 'wcw.previewUiState.v1';

export function normalizePreviewUiState(value) {
  let input = value;
  if (typeof input === 'string') {
    try { input = JSON.parse(input); } catch { input = null; }
  }
  const missions = {};
  const source = input && typeof input === 'object' && !Array.isArray(input) && input.missions && typeof input.missions === 'object'
    ? input.missions : {};
  for (const [missionId, raw] of Object.entries(source).slice(-1000)) {
    if (!missionId || !raw || typeof raw !== 'object' || Array.isArray(raw)) continue;
    const item = { pinned: raw.pinned === true, archived: raw.archived === true };
    const revision = Number(raw.lastSeenRevision);
    if (Number.isSafeInteger(revision) && revision >= 0) item.lastSeenRevision = revision;
    if (typeof raw.updatedAt === 'string' && raw.updatedAt) item.updatedAt = raw.updatedAt.slice(0, 40);
    missions[String(missionId).slice(0, 180)] = item;
  }
  return { version: 1, missions };
}

export function readPreviewUiState(storage = globalThis.localStorage) {
  try { return normalizePreviewUiState(storage?.getItem(PREVIEW_UI_STATE_STORAGE_KEY)); }
  catch { return normalizePreviewUiState(null); }
}

export function writePreviewMissionUiState(missionId, patch, storage = globalThis.localStorage) {
  const id = String(missionId || '').slice(0, 180);
  if (!id) return normalizePreviewUiState(null);
  const state = readPreviewUiState(storage);
  const previous = state.missions[id] || { pinned: false, archived: false };
  const next = { ...previous };
  if (patch && typeof patch === 'object') {
    if (typeof patch.pinned === 'boolean') next.pinned = patch.pinned;
    if (typeof patch.archived === 'boolean') next.archived = patch.archived;
    const revision = Number(patch.lastSeenRevision);
    if (Number.isSafeInteger(revision) && revision >= 0) next.lastSeenRevision = Math.max(Number(previous.lastSeenRevision) || 0, revision);
  }
  next.updatedAt = new Date().toISOString();
  state.missions[id] = next;
  try { storage?.setItem(PREVIEW_UI_STATE_STORAGE_KEY, JSON.stringify(state)); } catch { /* best-effort local view state */ }
  return state;
}

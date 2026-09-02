// Project persistence.
//
// Each project is its own IndexedDB database, so switching is opening a
// different one and deleting is deleteDatabase(). The alternative, one database
// with a projectId on every record, would put a filter in front of every read
// for no benefit.
//
// The project *list* is small scalar metadata, so it lives in localStorage.
// Blobs never go near it.

const LIST_KEY = 'qckcut.projects';
const ACTIVE_KEY = 'qckcut.active';
const DB_NAME = (id) => `qckcut-${id}`;
const VERSION = 1;
const STORES = ['sources', 'clips', 'timeline', 'music', 'settings'];

let handle = null;
let openId = null;

// ─── The project list ────────────────────────────────────────────────────────

export function projects() {
  try {
    const list = JSON.parse(localStorage.getItem(LIST_KEY) ?? '[]');
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}

function writeProjects(list) {
  localStorage.setItem(LIST_KEY, JSON.stringify(list));
}

export function touchProject(id, at) {
  const list = projects().map((p) => (p.id === id ? { ...p, updatedAt: at } : p));
  writeProjects(list);
}

export function createProject(name, id, at) {
  const project = { id, name, updatedAt: at };
  writeProjects([project, ...projects()]);
  return project;
}

export function renameProject(id, name) {
  writeProjects(projects().map((p) => (p.id === id ? { ...p, name } : p)));
}

export async function deleteProject(id) {
  if (openId === id) await close();
  writeProjects(projects().filter((p) => p.id !== id));
  if (activeProject() === id) localStorage.removeItem(ACTIVE_KEY);
  await new Promise((resolve) => {
    const request = indexedDB.deleteDatabase(DB_NAME(id));
    request.onsuccess = request.onerror = request.onblocked = () => resolve();
  });
}

export const activeProject = () => localStorage.getItem(ACTIVE_KEY);

/** Point every store call at this project. */
export async function use(id) {
  if (openId === id) return;
  await close();
  openId = id;
  localStorage.setItem(ACTIVE_KEY, id);
}

export async function close() {
  if (!handle) {
    openId = null;
    return;
  }
  const db = await handle;
  db.close();
  handle = null;
  openId = null;
}

// ─── The open project's database ─────────────────────────────────────────────

function db() {
  if (!openId) throw new Error('no project is open');
  handle ??= new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME(openId), VERSION);
    request.onupgradeneeded = () => {
      const d = request.result;
      for (const store of STORES) {
        if (!d.objectStoreNames.contains(store)) d.createObjectStore(store, { keyPath: 'id' });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  return handle;
}

async function run(store, mode, action) {
  const d = await db();
  return new Promise((resolve, reject) => {
    const transaction = d.transaction(store, mode);
    const request = action(transaction.objectStore(store));
    let result;
    // Resolve on the transaction, not the request: request.onsuccess fires
    // before the transaction commits, so awaiting it and then navigating away
    // aborts the write. That silently lost edits made just before a reload.
    if (request) request.onsuccess = () => { result = request.result; };
    transaction.oncomplete = () => resolve(result);
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error ?? new Error(`${store} transaction aborted`));
  });
}

// Only the durable fields go to disk. Decoded thumbnails and open decoders are
// rebuilt on load; neither is structured-cloneable anyway.
const sourceRecord = ({ id, name, blob, kind, duration, width, height, codec }) =>
  ({ id, name, blob, kind, duration, width, height, codec });

export const putSource = (source) => run('sources', 'readwrite', (s) => s.put(sourceRecord(source)));
export const dropSource = (id) => run('sources', 'readwrite', (s) => s.delete(id));
export const allSources = () => run('sources', 'readonly', (s) => s.getAll());

export const putClip = (clip) => run('clips', 'readwrite', (s) => s.put(clip));
export const dropClip = (id) => run('clips', 'readwrite', (s) => s.delete(id));
export const allClips = () => run('clips', 'readonly', (s) => s.getAll());

// The sequence is stored whole rather than per item: its order *is* its
// timing, so a partial write would be a reordered sequence.
/**
 * Every lane's items in one store, tagged with the lane they belong to. Order
 * within a lane is its timing, so a partial write would be a reordered lane;
 * the whole set is rewritten together.
 *
 * `trackId` of null is the video lane. Records written before lanes existed
 * have no trackId at all, so old projects migrate by doing nothing.
 */
export async function putTimeline(lanes) {
  await run('timeline', 'readwrite', (s) => s.clear());
  for (const { trackId, items } of lanes) {
    for (const [index, item] of items.entries()) {
      await run('timeline', 'readwrite', (s) => s.put({ ...item, index, trackId: trackId ?? null }));
    }
  }
}

/** Items grouped by lane id, video under the null key. */
export async function allTimeline() {
  const rows = await run('timeline', 'readonly', (s) => s.getAll());
  const lanes = new Map();
  for (const row of rows.sort((a, b) => a.index - b.index)) {
    const { index, trackId, ...item } = row;
    const key = trackId ?? null;
    if (!lanes.has(key)) lanes.set(key, []);
    lanes.get(key).push(item);
  }
  return lanes;
}

// At most one music bed, so it is stored under a fixed key rather than by id.
const MUSIC_KEY = 'bed';

export const putMusic = (music) => run('music', 'readwrite',
  (s) => s.put({ id: MUSIC_KEY, name: music.name, blob: music.blob, gain: music.gain }));
export const dropMusic = () => run('music', 'readwrite', (s) => s.delete(MUSIC_KEY));
export const getMusic = () => run('music', 'readonly', (s) => s.get(MUSIC_KEY));

export async function clearAll() {
  for (const store of STORES) await run(store, 'readwrite', (s) => s.clear());
}

// ─── Output settings ─────────────────────────────────────────────────────────
// Nulls mean "match the source", which is the default and what most exports
// want. Stored per project, since it describes that project's deliverable.

const SETTINGS_KEY = 'output';
const TRANSITIONS_KEY = 'transitions';

export const putSettings = (settings) =>
  run('settings', 'readwrite', (s) => s.put({ ...settings, id: SETTINGS_KEY }));

const TRACKS_KEY = 'tracks';

// The lane list is stored separately so an empty lane survives a reload; it has
// no items to be inferred from.
export const putTracks = (ids) =>
  run('settings', 'readwrite', (s) => s.put({ id: TRACKS_KEY, ids }));

export async function getTracks() {
  const row = await run('settings', 'readonly', (s) => s.get(TRACKS_KEY));
  return Array.isArray(row?.ids) ? row.ids : null;
}

export const putTransitions = (value) =>
  run('settings', 'readwrite', (s) => s.put({ ...value, id: TRANSITIONS_KEY }));

export async function getTransitions() {
  const row = await run('settings', 'readonly', (s) => s.get(TRANSITIONS_KEY));
  return row ? { intro: row.intro ?? null, outro: row.outro ?? null } : null;
}

export async function getSettings() {
  const row = await run('settings', 'readonly', (s) => s.get(SETTINGS_KEY));
  return row ? { width: row.width ?? null, height: row.height ?? null, fps: row.fps ?? null } : null;
}

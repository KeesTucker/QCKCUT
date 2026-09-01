// Project persistence. Sources hold blobs, which localStorage cannot take, so
// IndexedDB. Reloading the page restores the project, which is also what makes
// a no-build dev loop bearable: a save does not cost you a re-import.

const NAME = 'qckcut';
const VERSION = 2;   // v2 renamed the 'clips' store from 'cuts'
let handle = null;

function db() {
  handle ??= new Promise((resolve, reject) => {
    const request = indexedDB.open(NAME, VERSION);
    request.onupgradeneeded = () => {
      const d = request.result;
      for (const store of ['sources', 'clips']) {
        if (!d.objectStoreNames.contains(store)) d.createObjectStore(store, { keyPath: 'id' });
      }
      if (d.objectStoreNames.contains('cuts')) d.deleteObjectStore('cuts');
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
const sourceRecord = ({ id, name, blob, duration, width, height, codec }) =>
  ({ id, name, blob, duration, width, height, codec });

export const putSource = (source) => run('sources', 'readwrite', (s) => s.put(sourceRecord(source)));
export const dropSource = (id) => run('sources', 'readwrite', (s) => s.delete(id));
export const allSources = () => run('sources', 'readonly', (s) => s.getAll());

export const putClip = (clip) => run('clips', 'readwrite', (s) => s.put(clip));
export const dropClip = (id) => run('clips', 'readwrite', (s) => s.delete(id));
export const allClips = () => run('clips', 'readonly', (s) => s.getAll());

export async function clearAll() {
  await run('sources', 'readwrite', (s) => s.clear());
  await run('clips', 'readwrite', (s) => s.clear());
}

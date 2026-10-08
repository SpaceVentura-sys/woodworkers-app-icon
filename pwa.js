/* Woodworkers Academy Van Inventory PWA support.
 * Handles API calls, offline cache, queued log entries, and reconnect sync.
 */

const WA_API_URL = 'https://script.google.com/a/macros/woodworkersacademy.com/s/AKfycbwyxPKzf7fHl8TL1EJZrrRQHWUjLXWRBwPJhdI4CoVFTq8d8hq-jghdsHccqBb7rrgP/exec';
const WA_DB_NAME = 'woodworkers-van-inventory';
const WA_DB_VERSION = 1;
let waDbPromise = null;
let waSyncInProgress = false;
let waServerOfflineUntil = 0;

function waCanTryServer() {
  return navigator.onLine && Date.now() >= waServerOfflineUntil;
}

function waMarkServerReachable() {
  waServerOfflineUntil = 0;
}

function waMarkServerUnreachable() {
  // iOS can report navigator.onLine=true in airplane mode / captive-network states.
  // Back off briefly after a real request failure so we do not spam the API.
  waServerOfflineUntil = Date.now() + 15000;
}

function waOpenDb() {
  if (waDbPromise) return waDbPromise;
  waDbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(WA_DB_NAME, WA_DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('kv')) db.createObjectStore('kv');
      if (!db.objectStoreNames.contains('queue')) db.createObjectStore('queue', { keyPath: 'eventId' });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return waDbPromise;
}

async function waDbGet(store, key) {
  const db = await waOpenDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, 'readonly');
    const req = tx.objectStore(store).get(key);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function waDbPut(store, value, key) {
  const db = await waOpenDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, 'readwrite');
    const os = tx.objectStore(store);
    const req = key === undefined ? os.put(value) : os.put(value, key);
    req.onsuccess = () => resolve(value);
    req.onerror = () => reject(req.error);
  });
}

async function waDbDelete(store, key) {
  const db = await waOpenDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, 'readwrite');
    const req = tx.objectStore(store).delete(key);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
  });
}

async function waDbGetAll(store) {
  const db = await waOpenDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, 'readonly');
    const req = tx.objectStore(store).getAll();
    req.onsuccess = () => resolve(req.result || []);
    req.onerror = () => reject(req.error);
  });
}

function waJsonp(action, params = {}, timeoutMs = 12000) {
  return new Promise((resolve, reject) => {
    const callback = '__wa_cb_' + Date.now() + '_' + Math.random().toString(36).slice(2);
    const script = document.createElement('script');
    const timer = setTimeout(() => {
      waMarkServerUnreachable();
      finish(new Error('Request timed out'));
    }, timeoutMs);

    function finish(err, data) {
      clearTimeout(timer);
      try { delete window[callback]; } catch (_) { window[callback] = undefined; }
      script.remove();
      err ? reject(err) : resolve(data);
    }

    window[callback] = data => {
      waMarkServerReachable();
      finish(null, data);
    };
    script.onerror = () => {
      waMarkServerUnreachable();
      finish(new Error('Could not reach inventory server'));
    };

    const query = new URLSearchParams({
      api: '1',
      action,
      callback,
      _: String(Date.now()),
      ...params
    });
    script.src = WA_API_URL + '?' + query.toString();
    document.head.appendChild(script);
  });
}

function waMakeEventId() {
  if (crypto && typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  return 'evt-' + Date.now() + '-' + Math.random().toString(36).slice(2, 12);
}

async function waPendingCount() {
  try { return (await waDbGetAll('queue')).length; }
  catch (_) { return 0; }
}

async function waUpdateStatus(message) {
  const bar = document.getElementById('syncStatusBar');
  const text = document.getElementById('syncStatusText');
  const pending = await waPendingCount();
  const online = waCanTryServer();

  if (!bar || !text) return;

  let label = message || (online ? 'Online' : 'Offline');
  if (!online && message && !/^Offline\b/i.test(message)) label = 'Offline • ' + message;
  if (pending) label += ' • ' + pending + ' change' + (pending === 1 ? '' : 's') + ' waiting to sync';

  const lastSync = await waDbGet('kv', 'lastSync');
  if (lastSync) {
    const when = new Date(lastSync);
    if (!Number.isNaN(when.getTime())) {
      const time = when.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
      if (!message && online && !pending) label = 'Synced • ' + time;
      else if (!online && !/Last synced/i.test(label)) label += ' • Last synced ' + time;
    }
  }

  text.textContent = label;
  bar.className = 'px-4 py-1.5 text-center text-[11px] font-bold border-b ' +
    (!online ? 'bg-amber-100 text-amber-900 border-amber-200' :
      pending ? 'bg-blue-50 text-blue-800 border-blue-200' :
      'bg-emerald-50 text-emerald-800 border-emerald-200');
}

async function apiGetToolItems() {
  const cached = await waDbGet('kv', 'tools');
  const hasCached = cached !== undefined && cached !== null;

  if (!waCanTryServer()) {
    await waUpdateStatus(hasCached ? 'Using cached data' : 'No cached tool list yet');
    if (hasCached) return cached;
    throw new Error('No cached tool list is available yet. Connect once to load it for offline use.');
  }

  try {
    const res = await waJsonp('tools');
    if (!res || !res.success) throw new Error(res && res.error ? res.error : 'Tool list request failed');
    await waDbPut('kv', res.data || [], 'tools');
    await waDbPut('kv', new Date().toISOString(), 'lastSync');
    await waUpdateStatus();
    return res.data || [];
  } catch (err) {
    waMarkServerUnreachable();
    if (hasCached) {
      await waUpdateStatus('Using cached data');
      return cached;
    }
    await waUpdateStatus('No cached tool list yet');
    throw new Error('Offline and no cached tool list is available yet. Connect once to load it.');
  }
}

async function apiGetInventory(tabKey) {
  const cacheKey = 'inventory:' + tabKey;
  const cached = await waDbGet('kv', cacheKey);
  const hasCached = cached !== undefined && cached !== null;

  if (!waCanTryServer()) {
    await waUpdateStatus(hasCached ? 'Using cached inventory' : 'No cached inventory for this view');
    if (hasCached) return cached;
    throw new Error('No cached inventory is available for this view yet. Connect once and open this view to save it for offline use.');
  }

  try {
    const res = await waJsonp('inventory', { tab: tabKey });
    if (!res || !res.success) throw new Error(res && res.error ? res.error : 'Inventory request failed');
    await waDbPut('kv', res.data || [], cacheKey);
    await waDbPut('kv', new Date().toISOString(), 'lastSync');
    await waUpdateStatus();
    return res.data || [];
  } catch (err) {
    waMarkServerUnreachable();
    if (hasCached) {
      await waUpdateStatus('Using cached inventory');
      return cached;
    }
    await waUpdateStatus('No cached inventory for this view');
    throw new Error('Offline and no cached inventory is available for this view yet. Connect once and open this view to cache it.');
  }
}

async function waSendQueuedEvent(event) {
  const res = await waJsonp('submit', { payload: JSON.stringify(event) }, 20000);
  if (!res || !res.success) throw new Error(res && res.error ? res.error : 'Save failed');
  return res;
}

async function apiSubmitLog(payload) {
  const event = {
    ...payload,
    eventId: payload.eventId || waMakeEventId(),
    clientTimestamp: payload.clientTimestamp || new Date().toISOString()
  };

  // Save first. If the browser/app closes during the request, the event is still recoverable.
  await waDbPut('queue', event);
  await waUpdateStatus(waCanTryServer() ? 'Saving…' : 'Saved offline');

  if (!waCanTryServer()) {
    await waUpdateStatus('Saved offline');
    return { success: true, queued: true, item: event.item };
  }

  try {
    const res = await waSendQueuedEvent(event);
    await waDbDelete('queue', event.eventId);
    await waDbPut('kv', new Date().toISOString(), 'lastSync');
    await waUpdateStatus();
    return res;
  } catch (err) {
    // Leave it queued so reconnect sync can retry safely.
    await waUpdateStatus('Saved offline');
    return { success: true, queued: true, item: event.item, warning: err.message };
  }
}

async function waSyncPending() {
  if (waSyncInProgress || !waCanTryServer()) {
    await waUpdateStatus();
    return;
  }
  waSyncInProgress = true;
  try {
    const events = await waDbGetAll('queue');
    if (!events.length) {
      await waUpdateStatus();
      return;
    }
    await waUpdateStatus('Syncing ' + events.length + ' change' + (events.length === 1 ? '' : 's') + '…');
    for (const event of events) {
      try {
        await waSendQueuedEvent(event);
        await waDbDelete('queue', event.eventId);
      } catch (err) {
        console.warn('Sync paused:', err);
        break;
      }
    }
    await waDbPut('kv', new Date().toISOString(), 'lastSync');
    await waUpdateStatus();
  } finally {
    waSyncInProgress = false;
  }
}


async function waWarmInventoryCache() {
  if (!waCanTryServer()) return;
  const tabs = ['2026', '2021', '2015', 'class', 'summary'];
  await Promise.allSettled(tabs.map(tab => apiGetInventory(tab)));
}

async function waInitPwa() {
  try { await waOpenDb(); } catch (err) { console.warn('IndexedDB unavailable', err); }
  await waUpdateStatus();
  if ('serviceWorker' in navigator) {
    try { await navigator.serviceWorker.register('./service-worker.js'); }
    catch (err) { console.warn('Service worker registration failed', err); }
  }
  if (waCanTryServer()) {
    waSyncPending();
    // Pre-cache every inventory tab so the whole viewer is available offline after the first online launch.
    setTimeout(() => waWarmInventoryCache(), 500);
  }
}

window.addEventListener('online', () => { waMarkServerReachable(); waSyncPending(); });
window.addEventListener('offline', () => { waMarkServerUnreachable(); waUpdateStatus(); });
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && waCanTryServer()) waSyncPending();
});

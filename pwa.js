/* Woodworkers Academy Van Inventory PWA support.
 * Handles API calls, offline cache, queued log entries, and reconnect sync.
 */

const WA_API_URL = 'https://script.google.com/a/macros/woodworkersacademy.com/s/AKfycbwyxPKzf7fHl8TL1EJZrrRQHWUjLXWRBwPJhdI4CoVFTq8d8hq-jghdsHccqBb7rrgP/exec';
const WA_API_KEY = 'wa_7uK4nP9qR2mX8cV5sD1fH6jL3bT0yE';
const WA_DB_NAME = 'woodworkers-van-inventory';
const WA_DB_VERSION = 1;
let waDbPromise = null;
let waSyncInProgress = false;
function waCanTryServer() {
  // Do not persist a temporary 'server offline' state. iOS can miss or delay
  // online/offline events when returning from airplane mode. We use
  // navigator.onLine only as a hint and let each real request decide whether
  // the server is reachable; failed requests fall back to IndexedDB.
  return navigator.onLine !== false;
}

function waMarkServerReachable() {}
function waMarkServerUnreachable() {}

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

function waJsonp(action, params = {}, timeoutMs = 3500) {
  // If the browser already knows it is offline, do not create a network request at all.
  if (navigator.onLine === false) {
    return Promise.reject(new Error('Offline'));
  }
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
      key: WA_API_KEY,
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
  const res = await waJsonp('submit', { payload: JSON.stringify(event) }, 5000);
  if (!res || !res.success) throw new Error(res && res.error ? res.error : 'Save failed');
  return res;
}



function waLocationInfo(location, areaHint = '') {
  const raw = String(location || '').trim();
  const lower = raw.toLowerCase();
  if (!raw) return null;

  if (lower === 'class stock') return { type: 'class', summaryField: 'classStock' };
  if (lower === 'broken bin') return { type: 'class', summaryField: 'broken', classField: 'brokenBin' };
  if (lower === 'repaired bin') return { type: 'class', summaryField: 'repaired', classField: 'repairedBin' };
  if (lower === 'missing') return { type: 'class', summaryField: 'missing', classField: 'missing' };
  if (lower === 'e-commerce stock') return { type: 'untracked' };
  if (lower === 'tool room' || lower === 'purchased' || lower === 'disposed') return { type: 'untracked' };

  if (lower.includes('2015 van')) return { type: 'van', tab: '2015', summaryField: 'van2015' };
  if (lower.includes('2021 van')) return { type: 'van', tab: '2021', summaryField: 'van2021' };
  if (lower.includes('2026')) {
    let area = String(areaHint || '').trim();
    if (!area) {
      if (lower.includes('floor')) area = 'Floor Level Bins';
      else if (lower.includes('2nd')) area = '2nd Level Bins';
      else if (lower.includes('other')) area = '__OTHER__';
    }
    return { type: 'van', tab: '2026', summaryField: 'van2026', area };
  }
  return { type: 'untracked' };
}

function waSameItem(a, b) {
  return String(a || '').trim().toLowerCase() === String(b || '').trim().toLowerCase();
}

function waClampQty(value) {
  const n = Number(value) || 0;
  return Math.max(0, n);
}

async function waAdjustCachedLocation(itemName, location, delta, areaHint = '') {
  if (!delta) return;
  const info = waLocationInfo(location, areaHint);
  if (!info || info.type === 'untracked') return;

  // Tool Summary is the safest optimistic view because each location has one total.
  const summary = await waDbGet('kv', 'inventory:summary');
  if (Array.isArray(summary) && info.summaryField) {
    const row = summary.find(r => waSameItem(r.item, itemName));
    if (row) {
      row[info.summaryField] = waClampQty((Number(row[info.summaryField]) || 0) + delta);
      await waDbPut('kv', summary, 'inventory:summary');
    }
  }

  // Class Stock / Broken / Repaired have one row per tool, so these are also unambiguous.
  if (info.type === 'class') {
    const classData = await waDbGet('kv', 'inventory:class');
    if (Array.isArray(classData)) {
      const row = classData.find(r => waSameItem(r.tool, itemName));
      const field = info.classField || 'classStock';
      if (row && Object.prototype.hasOwnProperty.call(row, field)) {
        row[field] = waClampQty((Number(row[field]) || 0) + delta);
        await waDbPut('kv', classData, 'inventory:class');
      }
    }
  }

  // Van sheets can contain the same tool in multiple bins. Only alter a van card when
  // there is exactly one unambiguous matching row for the selected location/area.
  if (info.type === 'van') {
    const key = 'inventory:' + info.tab;
    const vanData = await waDbGet('kv', key);
    if (!Array.isArray(vanData)) return;

    let matches = vanData.filter(r => waSameItem(r.item, itemName));
    if (info.tab === '2026' && info.area) {
      if (info.area === '__OTHER__') {
        matches = matches.filter(r => {
          const a = String(r.area || '').toLowerCase();
          return !a.includes('floor level') && !a.includes('2nd level');
        });
      } else {
        matches = matches.filter(r => String(r.area || '').trim().toLowerCase() === info.area.toLowerCase());
      }
    }

    if (matches.length === 1) {
      matches[0].quantity = waClampQty((Number(matches[0].quantity) || 0) + delta);
      await waDbPut('kv', vanData, key);
    }
  }
}

async function waApplyOptimisticInventoryChange(event) {
  const qty = Math.max(0, Number(event.quantity) || 0);
  if (!qty || !event.item) return;

  const action = String(event.action || '');

  if (action === 'Restocked from tool room') {
    await waAdjustCachedLocation(event.item, event.whichVanRestocked, qty);
    return;
  }

  if (action === 'Broke, Needs replacement' || action === 'Missing, Needs replacement') {
    const isBroken = action.startsWith('Broke');
    await waAdjustCachedLocation(event.item, isBroken ? 'Broken Bin' : 'Missing', qty);

    let replaced = 0;
    if (event.didYouReplace === 'Yes, from class stock') {
      replaced = qty;
      await waAdjustCachedLocation(event.item, 'Class Stock', -qty);
    } else if (event.didYouReplace === 'Yes, from repaired bin') {
      replaced = qty;
      await waAdjustCachedLocation(event.item, 'Repaired Bin', -qty);
    } else if (event.didYouReplace === 'Yes, split locations/partially replaced') {
      const fromRepaired = Math.max(0, Number(event.qtyRepairedBin) || 0);
      const fromClass = Math.max(0, Number(event.qtyClassStock) || 0);
      replaced = Math.min(qty, fromRepaired + fromClass);
      if (fromRepaired) await waAdjustCachedLocation(event.item, 'Repaired Bin', -fromRepaired);
      if (fromClass) await waAdjustCachedLocation(event.item, 'Class Stock', -fromClass);
    }

    // A replacement goes back into the location the broken/missing tool came from,
    // so only the unreplaced portion lowers that location's on-hand quantity.
    const netLoss = Math.max(0, qty - replaced);
    if (netLoss) await waAdjustCachedLocation(event.item, event.vanOrLocationBroke, -netLoss);
    return;
  }

  if (action === 'Repaired') {
    await waAdjustCachedLocation(event.item, 'Broken Bin', -qty);
    await waAdjustCachedLocation(event.item, event.repairedMovedTo, qty);
    return;
  }

  if (action === 'Moved/Transferred Stock') {
    await waAdjustCachedLocation(event.item, event.transferMovedFrom, -qty);
    await waAdjustCachedLocation(event.item, event.transferMovedTo, qty);
    return;
  }

  if (action === 'Other Event (Found, Disposed, Purchased, Sold)') {
    if (event.otherMovedFrom) await waAdjustCachedLocation(event.item, event.otherMovedFrom, -qty);
    if (event.otherMovedTo) await waAdjustCachedLocation(event.item, event.otherMovedTo, qty);
  }
}


async function waRefreshVisibleInventoryFromCache() {
  // Keep the page's in-memory inventory in sync with the IndexedDB snapshot.
  // Without this, an offline event can update the stored cache while the currently
  // rendered inventory still shows the old numbers until the tab is reloaded.
  if (typeof invCache !== 'object' || !invCache) return;

  for (const tab of ['2026', '2021', '2015', 'class', 'summary']) {
    try {
      const cached = await waDbGet('kv', 'inventory:' + tab);
      if (cached !== undefined && cached !== null) invCache[tab] = cached;
    } catch (_) {}
  }

  try {
    if (typeof renderBinTiles === 'function') renderBinTiles();
    if (typeof renderFilteredInventory === 'function') renderFilteredInventory();
  } catch (err) {
    console.warn('Could not refresh visible cached inventory:', err);
  }
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
    await waApplyOptimisticInventoryChange(event);
    await waRefreshVisibleInventoryFromCache();
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
    // Leave it queued so reconnect sync can retry safely, and reflect the pending
    // movement in cached totals immediately.
    await waApplyOptimisticInventoryChange(event);
    await waRefreshVisibleInventoryFromCache();
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
    // Replace optimistic cached numbers with the authoritative sheet values after reconnect.
    setTimeout(() => waWarmInventoryCache(), 700);
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

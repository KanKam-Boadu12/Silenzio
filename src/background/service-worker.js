import { LOG_PREFIX, MessageType, STORAGE_KEY, duplexStatus } from '../shared/constants.js';

function updateBadge(state) {
  if (!chrome.action) {
    return;
  }

  if (!state.enabled) {
    chrome.action.setBadgeText({ text: 'OFF' });
    chrome.action.setBadgeBackgroundColor({ color: '#6b7280' });
    return;
  }

  if (state.status === 'inactive' || state.status === 'failed' || state.failure) {
    chrome.action.setBadgeText({ text: 'ERR' });
    chrome.action.setBadgeBackgroundColor({ color: '#ef4444' });
    return;
  }

  if (state.status === 'starting') {
    chrome.action.setBadgeText({ text: '...' });
    chrome.action.setBadgeBackgroundColor({ color: '#3b82f6' });
    return;
  }

  if (state.status === 'active') {
    chrome.action.setBadgeText({ text: 'ON' });
    chrome.action.setBadgeBackgroundColor({ color: '#10b981' });
    return;
  }

  chrome.action.setBadgeText({ text: '' });
}

function logDuplex(state, tabId) {
  const you = state.txProcessing ? 'live' : state.txStatus;
  const them = state.rxProcessing ? 'live' : state.rxStatus;
  const duplex = state.duplex ?? duplexStatus(state);

  console.info(LOG_PREFIX, `duplex: ${duplex}`, {
    tabId,
    you,
    them,
    enabled: state.enabled,
    status: state.status,
    txStatus: state.txStatus,
    rxStatus: state.rxStatus,
    txProcessing: state.txProcessing,
    rxProcessing: state.rxProcessing,
  });
}

const initialState = {
  enabled: true,
  txEnabled: true,
  rxEnabled: true,
  status: 'starting',
  txStatus: 'idle',
  rxStatus: 'idle',
  processing: false,
  txProcessing: false,
  rxProcessing: false,
  duplex: 'starting',
  failure: null,
  selectedDeviceId: '',
  devices: [],
};

let lastDuplexKey = '';
const frameStates = new Map();

function frameKey(sender) {
  return `${sender.tab?.id ?? 'unknown'}:${sender.frameId ?? 0}`;
}

function stateRank(state) {
  if (!state?.enabled) return 0;
  if (state.txProcessing || state.rxProcessing || state.processing) return 5;
  if (state.status === 'active') return 4;
  if (state.status === 'starting') return 3;
  if (state.status === 'inactive' || state.status === 'failed' || state.failure) return 2;
  return 1;
}

function bestStateForTab(tabId) {
  const prefix = `${tabId}:`;
  let best = null;
  for (const [key, state] of frameStates) {
    if (!key.startsWith(prefix)) continue;
    if (!best || stateRank(state) > stateRank(best)) best = state;
  }
  return best;
}

function clearTabFrames(tabId) {
  const prefix = `${tabId}:`;
  for (const key of frameStates.keys()) {
    if (key.startsWith(prefix)) frameStates.delete(key);
  }
}

chrome.tabs.onRemoved.addListener((tabId) => {
  clearTabFrames(tabId);
});

chrome.tabs.onUpdated.addListener((tabId, info) => {
  if (info.status === 'loading') clearTabFrames(tabId);
});

chrome.runtime.onInstalled.addListener(() => {
  chrome.storage.session.set({ [STORAGE_KEY]: initialState });
  updateBadge(initialState);
  console.info(LOG_PREFIX, 'installed — auto-enable on');
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type !== MessageType.EVENT) {
    return false;
  }

  const incoming = message.event ?? {};
  const tabId = sender.tab?.id;
  const isError = incoming.status === 'inactive' || incoming.detail?.type === 'error';

  if (isError) {
    console.error(LOG_PREFIX, incoming.message ?? 'DTLN inactive', {
      tabId,
      failure: incoming.failure ?? incoming.detail,
      event: incoming,
    });
  } else {
    console.info(LOG_PREFIX, incoming.message ?? 'event', {
      tabId,
      status: incoming.status,
      duplex: incoming.duplex,
      txStatus: incoming.txStatus,
      rxStatus: incoming.rxStatus,
      txProcessing: incoming.txProcessing,
      rxProcessing: incoming.rxProcessing,
      processing: incoming.processing,
      detail: incoming.detail,
    });
  }

  chrome.storage.session.get(STORAGE_KEY).then((result) => {
    const current = result[STORAGE_KEY] ?? initialState;
    frameStates.set(frameKey(sender), {
      enabled: incoming.enabled ?? current.enabled,
      txEnabled: incoming.txEnabled ?? current.txEnabled,
      rxEnabled: incoming.rxEnabled ?? current.rxEnabled,
      selectedDeviceId: incoming.selectedDeviceId ?? current.selectedDeviceId,
      devices: incoming.devices ?? current.devices ?? [],
      status: incoming.status ?? current.status,
      txStatus: incoming.txStatus ?? current.txStatus,
      rxStatus: incoming.rxStatus ?? current.rxStatus,
      processing: incoming.processing ?? current.processing,
      txProcessing: incoming.txProcessing ?? current.txProcessing,
      rxProcessing: incoming.rxProcessing ?? current.rxProcessing,
      failure: Object.hasOwn(incoming, 'failure') ? incoming.failure : current.failure,
      duplex: incoming.duplex,
    });
    const preferred = bestStateForTab(tabId) ?? incoming;
    const updated = {
      ...current,
      ...preferred,
      devices: preferred.devices ?? current.devices ?? [],
    };
    updated.duplex = preferred.duplex ?? duplexStatus(updated);

    const duplexKey = `${tabId}:${updated.duplex}:${updated.txProcessing}:${updated.rxProcessing}:${updated.txStatus}:${updated.rxStatus}`;
    if (duplexKey !== lastDuplexKey) {
      lastDuplexKey = duplexKey;
      logDuplex(updated, tabId);
    }

    chrome.storage.session.set({ [STORAGE_KEY]: updated });
    updateBadge(updated);
    sendResponse({ ok: true });
  });

  return true;
});

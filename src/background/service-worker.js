import { LOG_PREFIX, MessageType, STORAGE_KEY } from '../shared/constants.js';

function updateBadge(state) {
  if (!chrome.action) {
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
  failure: null,
  selectedDeviceId: '',
  devices: [],
};

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
      txStatus: incoming.txStatus,
      rxStatus: incoming.rxStatus,
      processing: incoming.processing,
      detail: incoming.detail,
    });
  }

  chrome.storage.session.get(STORAGE_KEY).then((result) => {
    const current = result[STORAGE_KEY] ?? initialState;
    const updated = {
      ...current,
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
      failure: incoming.failure ?? current.failure,
    };

    chrome.storage.session.set({ [STORAGE_KEY]: updated });
    updateBadge(updated);
    sendResponse({ ok: true });
  });

  return true;
});

import '../popup/popup.css';
import { LOG_PREFIX, MessageType, STORAGE_KEY, USER_ENABLED_STORAGE_KEY } from '../shared/constants.js';

function isConnectionError(error) {
  const message = String(error?.message ?? error ?? '');
  return (
    message.includes('Receiving end does not exist') ||
    message.includes('Could not establish connection')
  );
}

function statusLabel(state) {
  if (state.connectionError) {
    return { text: 'No call tab', kind: 'inactive' };
  }
  if (!state.enabled) {
    return { text: 'Off', kind: 'idle' };
  }
  if (state.status === 'inactive' || state.status === 'failed' || state.failure) {
    return { text: 'Error', kind: 'inactive' };
  }
  if (state.status === 'active') {
    return { text: 'On', kind: 'active' };
  }
  return { text: 'Starting…', kind: 'starting' };
}

export function createPopup(root) {
  let state = {
    status: 'idle',
    enabled: false,
    selectedDeviceId: '',
    devices: [],
    failure: null,
    connectionError: null,
    txProcessing: false,
    rxProcessing: false,
    txStatus: 'idle',
    rxStatus: 'idle',
  };
  let pollTimer = 0;
  let requestedEnabled = null;
  let requestedAt = 0;
  const REQUEST_SETTLE_MS = 10000;

  async function getActiveTab() {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    return tab;
  }

  async function sendToTab(tabId, type, payload = {}) {
    return chrome.tabs.sendMessage(tabId, { type, ...payload });
  }

  async function injectContentScript(tabId) {
    await chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
      files: ['page-bridge-main.js'],
      world: 'MAIN',
      injectImmediately: true,
    });
    await chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
      files: ['content-script.js'],
      injectImmediately: true,
    });
  }

  async function sendToActiveTab(type, payload = {}) {
    const tab = await getActiveTab();

    if (!tab?.id) {
      throw new Error('Open a call tab to use noise cancellation.');
    }

    assertSupportedTab(tab);

    try {
      return await sendToTab(tab.id, type, payload);
    } catch (error) {
      await injectContentScript(tab.id);
      await new Promise((resolve) => {
        window.setTimeout(resolve, 75);
      });
      try {
        return await sendToTab(tab.id, type, payload);
      } catch (retryError) {
        throw isConnectionError(retryError)
          ? new Error('Reload this call tab after updating the extension, then open the popup again.')
          : retryError;
      }
    }
  }

  function applyStored(stored = {}) {
    if (requestedEnabled !== null) {
      const settled =
        stored.enabled === requestedEnabled || Date.now() - requestedAt > REQUEST_SETTLE_MS;
      if (!settled) {
        return;
      }
      requestedEnabled = null;
    }

    state = {
      ...state,
      enabled: stored.enabled ?? state.enabled,
      selectedDeviceId: stored.selectedDeviceId ?? state.selectedDeviceId,
      devices: Array.isArray(stored.devices) ? stored.devices : state.devices,
      status: stored.status ?? state.status,
      failure: Object.hasOwn(stored, 'failure') ? stored.failure : state.failure,
      txProcessing: stored.txProcessing ?? state.txProcessing,
      rxProcessing: stored.rxProcessing ?? state.rxProcessing,
      txStatus: stored.txStatus ?? state.txStatus,
      rxStatus: stored.rxStatus ?? state.rxStatus,
    };
  }

  async function refresh() {
    const storedState = await chrome.storage.session.get(STORAGE_KEY);
    if (!storedState[STORAGE_KEY] && requestedEnabled === null) {
      const preference = await chrome.storage.local.get(USER_ENABLED_STORAGE_KEY);
      state = { ...state, enabled: preference[USER_ENABLED_STORAGE_KEY] !== false };
    }
    applyStored(storedState[STORAGE_KEY] ?? {});

    try {
      await sendToActiveTab(MessageType.GET_STATUS);
      state = { ...state, connectionError: null };
    } catch (error) {
      console.warn(LOG_PREFIX, error.message);
      state = {
        ...state,
        connectionError: error.message,
      };
    }

    render();
  }

  async function toggleEnabled() {
    const nextEnabled = !state.enabled;
    requestedEnabled = nextEnabled;
    requestedAt = Date.now();
    state = {
      ...state,
      enabled: nextEnabled,
      status: nextEnabled ? 'starting' : 'idle',
      failure: null,
      connectionError: null,
    };
    render();

    try {
      await chrome.storage.local.set({ [USER_ENABLED_STORAGE_KEY]: nextEnabled });
      if (nextEnabled) {
        await sendToActiveTab(MessageType.ENABLE, { selectedDeviceId: state.selectedDeviceId });
      } else {
        await sendToActiveTab(MessageType.DISABLE);
      }
      await sendToActiveTab(MessageType.GET_STATUS);
      state = { ...state, connectionError: null };
    } catch (error) {
      console.warn(LOG_PREFIX, error.message);
      requestedEnabled = null;
      state = { ...state, connectionError: error.message };
    }

    render();
  }

  function assertSupportedTab(tab) {
    const url = tab.url ?? '';
    const blockedSchemes = ['chrome://', 'edge://', 'about:', 'devtools://', 'chrome-extension://'];

    if (blockedSchemes.some((scheme) => url.startsWith(scheme))) {
      throw new Error('Open a call tab to use noise cancellation.');
    }
  }

  function render() {
    const status = statusLabel(state);
    const alertMessage = state.connectionError || state.failure;

    root.innerHTML = `
      <section class="popup">
        <header class="popup__header">
          <h1 class="popup__title">Noise cancellation</h1>
          <span class="popup__status popup__status--${status.kind}">${status.text}</span>
        </header>

        <label class="popup__switch">
          <input type="checkbox" data-enabled-toggle ${state.enabled ? 'checked' : ''} />
          <span>${state.enabled ? 'On' : 'Off'}</span>
        </label>

        ${
          alertMessage
            ? `<p class="popup__alert" role="alert">${escapeHtml(alertMessage)}</p>`
            : ''
        }
      </section>
    `;

    root.querySelector('[data-enabled-toggle]')?.addEventListener('change', () => {
      toggleEnabled();
    });
  }

  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== 'session') {
      return;
    }

    const next = changes[STORAGE_KEY]?.newValue;

    if (!next) {
      return;
    }

    applyStored(next);
    render();
  });

  render();
  refresh();
  pollTimer = window.setInterval(() => {
    refresh();
  }, 1500);

  window.addEventListener('unload', () => {
    window.clearInterval(pollTimer);
  });
}

function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

createPopup(document.querySelector('#popup'));

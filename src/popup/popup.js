import '../popup/popup.css';
import { LOG_PREFIX, MessageType, STORAGE_KEY } from '../shared/constants.js';

const STATUS_LABEL = {
  idle: 'Starting…',
  starting: 'Starting…',
  active: 'Active',
  inactive: 'Inactive',
  failed: 'Inactive',
};

export function createPopup(root) {
  let state = {
    status: 'starting',
    enabled: true,
    selectedDeviceId: '',
    devices: [],
    failure: null,
  };

  async function getActiveTab() {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    return tab;
  }

  async function sendToActiveTab(type, payload = {}) {
    const tab = await getActiveTab();

    if (!tab?.id) {
      throw new Error('No active tab found');
    }

    assertSupportedTab(tab);
    await injectPageBridge(tab.id);

    try {
      return await chrome.tabs.sendMessage(tab.id, { type, ...payload });
    } catch (_error) {
      await injectContentScript(tab.id);
      return chrome.tabs.sendMessage(tab.id, { type, ...payload });
    }
  }

  async function injectContentScript(tabId) {
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ['content-script.js'],
    });
  }

  async function injectPageBridge(tabId) {
    try {
      await chrome.scripting.executeScript({
        target: { tabId },
        files: ['page-bridge.js'],
        world: 'MAIN',
      });
    } catch (_error) {
      // Already injected or blocked by the page
    }
  }

  async function refresh() {
    const storedState = await chrome.storage.session.get(STORAGE_KEY);
    const stored = storedState[STORAGE_KEY] ?? {};

    state = {
      ...state,
      enabled: stored.enabled ?? true,
      selectedDeviceId: stored.selectedDeviceId ?? state.selectedDeviceId,
      devices: Array.isArray(stored.devices) ? stored.devices : state.devices,
      status: stored.status ?? state.status,
      failure: stored.failure ?? state.failure,
    };

    try {
      await sendToActiveTab(MessageType.ENABLE, { selectedDeviceId: state.selectedDeviceId });
      await sendToActiveTab(MessageType.GET_INPUT_DEVICES);
    } catch (error) {
      console.warn(LOG_PREFIX, error.message);
      state = { ...state, status: 'inactive', failure: error.message };
    }

    render();
  }

  async function selectInputDevice(deviceId) {
    state = { ...state, selectedDeviceId: deviceId };
    render();

    try {
      await sendToActiveTab(MessageType.SELECT_INPUT_DEVICE, { deviceId });
    } catch (error) {
      console.warn(LOG_PREFIX, error.message);
    }
  }

  function assertSupportedTab(tab) {
    const url = tab.url ?? '';
    const blockedSchemes = ['chrome://', 'edge://', 'about:', 'devtools://', 'chrome-extension://'];

    if (blockedSchemes.some((scheme) => url.startsWith(scheme))) {
      throw new Error('Open a call tab to use noise cancellation.');
    }
  }

  function render() {
    const isLive = state.status === 'active';
    const devices = Array.isArray(state.devices) ? state.devices.filter((device) => device?.deviceId) : [];
    const deviceOptions = [
      `<option value="" ${!state.selectedDeviceId ? 'selected' : ''}>default</option>`,
      ...devices.map((device) => {
        const isSelected = device.deviceId === state.selectedDeviceId;
        return `<option value="${escapeHtml(device.deviceId)}" ${isSelected ? 'selected' : ''}>${escapeHtml(device.label || 'Microphone')}</option>`;
      }),
    ].join('');

    root.innerHTML = `
      <section class="popup">
        <header class="popup__header">
          <h1 class="popup__title">Noise cancellation</h1>
          <span class="popup__status popup__status--${isLive ? 'active' : state.status}">${STATUS_LABEL[state.status] ?? STATUS_LABEL.idle}</span>
        </header>

        ${
          state.failure && state.status === 'inactive'
            ? `<p class="popup__alert" role="alert">${escapeHtml(state.failure)}</p>`
            : ''
        }

        <section class="popup__panel" aria-label="Select microphone to denoise">
          <label class="popup__label" for="microphone-select">Select microphone to denoise</label>
          <select id="microphone-select" class="popup__select" data-microphone-select>
            ${deviceOptions}
          </select>
        </section>
      </section>
    `;

    root.querySelector('[data-microphone-select]')?.addEventListener('change', (event) => {
      selectInputDevice(event.target.value ?? '');
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

    state = {
      ...state,
      enabled: next.enabled ?? state.enabled,
      selectedDeviceId: next.selectedDeviceId ?? state.selectedDeviceId,
      devices: Array.isArray(next.devices) ? next.devices : state.devices,
      status: next.status ?? state.status,
      failure: next.failure ?? state.failure,
    };
    render();
  });

  render();
  refresh();
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

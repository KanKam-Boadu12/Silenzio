import {
  BRIDGE_DATASET_KEY,
  MessageType,
  PageCommand,
  PageMessageSource,
  USER_ENABLED_STORAGE_KEY,
} from '../shared/constants.js';

function injectPageBridge() {
  if (document.documentElement?.dataset[BRIDGE_DATASET_KEY] === '1') {
    return;
  }

  if (document.documentElement) {
    document.documentElement.dataset[BRIDGE_DATASET_KEY] = '1';
  }

  const script = document.createElement('script');
  script.src = chrome.runtime.getURL('page-bridge.js');
  script.type = 'module';
  script.async = false;
  script.dataset.noiseCancellation = 'page-bridge';
  const container = document.head || document.documentElement;
  if (container) {
    container.prepend(script);
  }
}

function postToPage(command) {
  window.postMessage(
    {
      source: PageMessageSource.EXTENSION,
      extensionBaseUrl: chrome.runtime.getURL(''),
      ...command,
    },
    window.location.origin,
  );
}

injectPageBridge();
postToPage({ command: PageCommand.INIT });

chrome.storage.local.get(USER_ENABLED_STORAGE_KEY).then((stored) => {
  const enabled = stored[USER_ENABLED_STORAGE_KEY] !== false;
  postToPage({ command: enabled ? PageCommand.ENABLE : PageCommand.DISABLE });
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === MessageType.ENABLE) {
    injectPageBridge();
    chrome.storage.local.set({ [USER_ENABLED_STORAGE_KEY]: true });
    postToPage({
      command: PageCommand.ENABLE,
      deviceId: message.selectedDeviceId,
    });
    sendResponse({ ok: true });
    return true;
  }

  if (message?.type === MessageType.DISABLE) {
    chrome.storage.local.set({ [USER_ENABLED_STORAGE_KEY]: false });
    postToPage({ command: PageCommand.DISABLE });
    sendResponse({ ok: true });
    return true;
  }

  if (message?.type === MessageType.GET_STATUS) {
    postToPage({ command: PageCommand.STATUS });
    sendResponse({ ok: true });
    return true;
  }

  if (message?.type === MessageType.SET_TOGGLES) {
    postToPage({
      command: PageCommand.SET_TOGGLES,
      txEnabled: message.txEnabled,
      rxEnabled: message.rxEnabled,
    });
    sendResponse({ ok: true });
    return true;
  }

  if (message?.type === MessageType.GET_INPUT_DEVICES) {
    postToPage({ command: PageCommand.LIST_DEVICES });
    sendResponse({ ok: true });
    return true;
  }

  if (message?.type === MessageType.SELECT_INPUT_DEVICE) {
    postToPage({
      command: PageCommand.SELECT_DEVICE,
      deviceId: message.deviceId,
    });
    sendResponse({ ok: true });
    return true;
  }

  return false;
});

window.addEventListener('message', (event) => {
  if (event.source !== window || event.data?.source !== PageMessageSource.PAGE) {
    return;
  }

  chrome.runtime.sendMessage(
    {
      type: MessageType.EVENT,
      event: event.data.event,
    },
    () => {
      void chrome.runtime.lastError;
    },
  );
});

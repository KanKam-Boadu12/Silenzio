export const APP_NAME = 'Agent Noise Cancellation';
export const LOG_PREFIX = `[${APP_NAME}]`;
export const STORAGE_KEY = 'noiseCancellation';

export const WINDOW_BRIDGE_FLAG = '__noiseCancellationBridgeInstalled';
export const WINDOW_STATE_KEY = '__noiseCancellationState';
export const BRIDGE_DATASET_KEY = 'noiseCancellationBridge';

export const MessageType = {
  ENABLE: 'noiseCancellation.enable',
  DISABLE: 'noiseCancellation.disable',
  GET_STATUS: 'noiseCancellation.getStatus',
  SET_TOGGLES: 'noiseCancellation.setToggles',
  GET_INPUT_DEVICES: 'noiseCancellation.getInputDevices',
  SELECT_INPUT_DEVICE: 'noiseCancellation.selectInputDevice',
  EVENT: 'noiseCancellation.event',
};

export const PageMessageSource = {
  EXTENSION: 'noiseCancellation.extension',
  PAGE: 'noiseCancellation.page',
};

export const PageCommand = {
  INIT: 'init',
  ENABLE: 'enable',
  DISABLE: 'disable',
  SET_TOGGLES: 'setToggles',
  STATUS: 'status',
  LIST_DEVICES: 'listDevices',
  SELECT_DEVICE: 'selectDevice',
};

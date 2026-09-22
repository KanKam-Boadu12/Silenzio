import { AudioPipeline, DEFAULT_MIC_CONSTRAINTS, DTLN_LAYER_COUNT } from '../audio/audio-pipeline.js';
import {
  LOG_PREFIX,
  PageCommand,
  PageMessageSource,
  WINDOW_BRIDGE_FLAG,
  WINDOW_STATE_KEY,
} from '../shared/constants.js';

if (window[WINDOW_BRIDGE_FLAG]) {
  window.postMessage(
    {
      source: PageMessageSource.PAGE,
      event: {
        message: 'extension: bridge already installed',
        enabled: window[WINDOW_STATE_KEY]?.enabled ?? true,
        txEnabled: window[WINDOW_STATE_KEY]?.txEnabled ?? true,
        rxEnabled: window[WINDOW_STATE_KEY]?.rxEnabled ?? true,
        selectedDeviceId: window[WINDOW_STATE_KEY]?.selectedDeviceId ?? '',
        devices: window[WINDOW_STATE_KEY]?.devices ?? [],
        status: window[WINDOW_STATE_KEY]?.status ?? 'idle',
        txStatus: window[WINDOW_STATE_KEY]?.txStatus ?? 'idle',
        rxStatus: window[WINDOW_STATE_KEY]?.rxStatus ?? 'idle',
        processing: window[WINDOW_STATE_KEY]?.processing ?? false,
        txProcessing: window[WINDOW_STATE_KEY]?.txProcessing ?? false,
        rxProcessing: window[WINDOW_STATE_KEY]?.rxProcessing ?? false,
        failure: window[WINDOW_STATE_KEY]?.failure ?? null,
        timestamp: Date.now(),
      },
    },
    window.location.origin,
  );
} else {
  window[WINDOW_BRIDGE_FLAG] = true;

  const FROM_EXTENSION = PageMessageSource.EXTENSION;
  const FROM_PAGE = PageMessageSource.PAGE;

  const state = {
    enabled: true,
    txEnabled: true,
    rxEnabled: true,
    selectedDeviceId: '',
    devices: [],
    assetBaseUrl: '/',
    installed: false,
    status: 'idle',
    txStatus: 'idle',
    rxStatus: 'idle',
    processing: false,
    txProcessing: false,
    rxProcessing: false,
    failure: null,
    events: [],
  };
  window[WINDOW_STATE_KEY] = state;

  const originals = {
    getUserMedia: navigator.mediaDevices?.getUserMedia?.bind(navigator.mediaDevices),
    RTCPeerConnection: window.RTCPeerConnection,
    mediaElementSrcObject: Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, 'srcObject'),
  };

  const peerConnections = new Set();
  const processedTracks = new WeakSet();
  const localMicTracks = new WeakSet();
  const remoteTracks = new WeakSet();
  const senderToRawTrackMap = new Map();
  const trackPairMap = new WeakMap();
  const activeMediaElements = new Map();
  const capturedRawTracks = new Set();

  let txPipeline = createPipeline('outgoing');
  let rxPipeline = createPipeline('incoming');

  function createPipeline(direction) {
    return new AudioPipeline({
      assetBaseUrl: state.assetBaseUrl,
      direction,
      layers: DTLN_LAYER_COUNT,
      onEvent: (event) => {
        if (direction === 'outgoing') {
          if (event.status) {
            state.txStatus = event.status;
          }
          if (event.type === 'processing-started') {
            state.txProcessing = true;
          }
        } else {
          if (event.status) {
            state.rxStatus = event.status;
          }
          if (event.type === 'processing-started') {
            state.rxProcessing = true;
          }
        }

        if (event.failure) {
          state.failure = event.failure;
        }

        state.processing = state.txProcessing || state.rxProcessing;
        updateOverallStatus();
        publish(`${event.pipeline}: ${event.type}`, event);
      },
    });
  }

  function updateOverallStatus() {
    if (!state.enabled) {
      state.status = 'idle';
      return;
    }

    const needed = [];
    if (state.txEnabled) {
      needed.push(state.txStatus);
    }
    if (state.rxEnabled) {
      needed.push(state.rxStatus);
    }

    if (needed.some((s) => s === 'inactive' || s === 'failed')) {
      state.status = 'inactive';
    } else if (needed.some((s) => s === 'starting')) {
      state.status = 'starting';
    } else if (needed.length > 0 && needed.every((s) => s === 'active')) {
      state.status = 'active';
    } else {
      state.status = 'idle';
    }
  }

  function publish(message, detail = {}) {
    const event = {
      message,
      detail,
      enabled: state.enabled,
      txEnabled: state.txEnabled,
      rxEnabled: state.rxEnabled,
      selectedDeviceId: state.selectedDeviceId,
      devices: state.devices,
      status: state.status,
      txStatus: state.txStatus,
      rxStatus: state.rxStatus,
      processing: state.processing,
      txProcessing: state.txProcessing,
      rxProcessing: state.rxProcessing,
      failure: state.failure,
      timestamp: Date.now(),
    };

    state.events = [event, ...state.events].slice(0, 15);
    console.info(LOG_PREFIX, message, detail);
    window.postMessage({ source: FROM_PAGE, event }, window.location.origin);
  }

  function audioRequested(constraints) {
    return constraints?.audio !== false;
  }

  function serializeDevices(devices) {
    return devices.map((device, index) => ({
      deviceId: device.deviceId,
      groupId: device.groupId,
      kind: device.kind,
      label: device.label || `Microphone ${index + 1}`,
    }));
  }

  async function refreshAvailableDevices() {
    if (!navigator.mediaDevices?.enumerateDevices) {
      state.devices = [];
      return [];
    }

    let mediaDevices = await navigator.mediaDevices.enumerateDevices();
    let audioInputs = mediaDevices.filter((device) => device.kind === 'audioinput');
    const needsLabels = audioInputs.length === 0 || audioInputs.every((device) => !device.label);

    if (needsLabels && originals.getUserMedia) {
      try {
        const probe = await originals.getUserMedia({ audio: true, video: false });
        probe.getTracks().forEach((track) => track.stop());
        mediaDevices = await navigator.mediaDevices.enumerateDevices();
        audioInputs = mediaDevices.filter((device) => device.kind === 'audioinput');
      } catch (error) {
        console.warn(`${LOG_PREFIX} microphone permission needed to list input devices`, error);
      }
    }

    state.devices = serializeDevices(audioInputs);

    if (state.selectedDeviceId && !state.devices.some((device) => device.deviceId === state.selectedDeviceId)) {
      state.selectedDeviceId = '';
    }

    return state.devices;
  }

  function cleanAudioConstraints(constraints) {
    if (!audioRequested(constraints)) {
      return constraints;
    }

    const requestedAudio = typeof constraints.audio === 'object' ? constraints.audio : {};
    const nextAudio = {
      ...requestedAudio,
      ...DEFAULT_MIC_CONSTRAINTS,
    };

    if (state.selectedDeviceId) {
      nextAudio.deviceId = { exact: state.selectedDeviceId };
    }

    return {
      ...constraints,
      audio: nextAudio,
    };
  }

  // --- OUTGOING (TX) INTERCEPTION ---
  async function getCleanUserMedia(constraints) {
    const rawStream = await originals.getUserMedia(cleanAudioConstraints(constraints));
    rawStream.getAudioTracks().forEach((t) => {
      localMicTracks.add(t);
      capturedRawTracks.add(t);
    });

    if (!audioRequested(constraints)) {
      return rawStream;
    }

    const ready = await ensureEnabled();
    if (!ready || !state.txEnabled || state.txStatus !== 'active') {
      console.error(`${LOG_PREFIX} returning raw microphone — TX noise cancellation INACTIVE`, state.failure);
      publish('outgoing: raw mic returned because DTLN TX is inactive', {
        pipeline: 'outgoing',
        type: 'inactive-passthrough',
        reason: state.failure,
      });
      return rawStream;
    }

    try {
      const processed = await txPipeline.processOutgoingStream(rawStream);
      const videoTracks = rawStream.getVideoTracks();
      if (processed.cleanTrack) {
        processedTracks.add(processed.cleanTrack);
        localMicTracks.add(processed.cleanTrack);
        trackPairMap.set(processed.cleanTrack, processed.rawTrack);
      }
      publish('outgoing: returned DTLN-denoised microphone stream', {
        pipeline: 'outgoing',
        type: 'stream-replaced',
        settings: processed.settings,
      });
      return new MediaStream([processed.cleanTrack, ...videoTracks].filter(Boolean));
    } catch (error) {
      state.txStatus = 'inactive';
      state.txProcessing = false;
      state.failure = error.message;
      updateOverallStatus();
      console.error(`${LOG_PREFIX} DTLN TX failed during getUserMedia — INACTIVE`, error);
      publish(`outgoing: ${error.message}`, {
        pipeline: 'outgoing',
        type: 'error',
        reason: error.message,
      });
      return rawStream;
    }
  }

  async function denoiseOutgoingTrack(track) {
    if (!track || track.kind !== 'audio' || processedTracks.has(track)) {
      return track;
    }

    capturedRawTracks.add(track);
    const processed = await txPipeline.processOutgoingStream(new MediaStream([track]));
    processedTracks.add(processed.cleanTrack);
    localMicTracks.add(processed.cleanTrack);
    trackPairMap.set(processed.cleanTrack, track);
    return processed.cleanTrack;
  }

  function patchPeerConnection(pc) {
    peerConnections.add(pc);

    pc.addEventListener('connectionstatechange', () => {
      if (pc.connectionState === 'closed' || pc.connectionState === 'failed') {
        peerConnections.delete(pc);
      }
    });

    pc.addEventListener('track', (event) => {
      if (event.track?.kind === 'audio') {
        remoteTracks.add(event.track);
        publish('incoming: remote audio track received from peer connection');
      }
    });

    const originalAddTrack = pc.addTrack.bind(pc);
    pc.addTrack = function addTrack(track, ...streams) {
      const sender = originalAddTrack(track, ...streams);

      if (track?.kind !== 'audio') {
        return sender;
      }

      senderToRawTrackMap.set(sender, track);
      ensureEnabled()
        .then((ready) => {
          if (!ready || !state.txEnabled || state.txStatus !== 'active') {
            return undefined;
          }
          return denoiseOutgoingTrack(track).then((cleanTrack) => {
            if (cleanTrack && cleanTrack !== track) {
              return sender.replaceTrack(cleanTrack);
            }
            return undefined;
          });
        })
        .catch((error) => {
          state.txStatus = 'inactive';
          state.txProcessing = false;
          state.failure = error.message;
          updateOverallStatus();
          console.error(`${LOG_PREFIX} replaceTrack failed — INACTIVE`, error);
          publish(`outgoing: ${error.message}`, {
            pipeline: 'outgoing',
            type: 'error',
            reason: error.message,
          });
        });

      return sender;
    };
  }

  function PatchedRTCPeerConnection(...args) {
    const pc = new originals.RTCPeerConnection(...args);
    patchPeerConnection(pc);
    return pc;
  }

  async function replaceExistingSenders() {
    if (!state.enabled || !state.txEnabled || state.txStatus !== 'active') {
      return;
    }

    for (const pc of peerConnections) {
      for (const sender of pc.getSenders()) {
        if (sender.track?.kind !== 'audio') {
          continue;
        }

        try {
          if (!senderToRawTrackMap.has(sender)) {
            const raw = trackPairMap.get(sender.track) || sender.track;
            senderToRawTrackMap.set(sender, raw);
          }
          const cleanTrack = await denoiseOutgoingTrack(sender.track);
          if (cleanTrack && cleanTrack !== sender.track) {
            await sender.replaceTrack(cleanTrack);
            publish('outgoing: replaced existing sender track', {
              pipeline: 'outgoing',
              type: 'replace-track',
            });
          }
        } catch (error) {
          console.error(`${LOG_PREFIX} existing sender replaceTrack failed`, error);
          publish(`outgoing: ${error.message}`, {
            pipeline: 'outgoing',
            type: 'error',
            reason: error.message,
          });
        }
      }
    }
  }

  async function restoreSenders() {
    for (const pc of peerConnections) {
      for (const sender of pc.getSenders()) {
        if (sender.track?.kind !== 'audio') {
          continue;
        }

        const rawTrack = senderToRawTrackMap.get(sender);
        if (rawTrack && rawTrack.readyState === 'live' && sender.track !== rawTrack) {
          try {
            await sender.replaceTrack(rawTrack);
            publish('outgoing: restored raw microphone track', {
              pipeline: 'outgoing',
              type: 'restore-raw-track',
            });
          } catch (error) {
            console.warn(`${LOG_PREFIX} failed to revert sender track`, error);
          }
        }
      }
    }
  }

  // --- INCOMING (RX) INTERCEPTION ---
  function isIncomingStream(stream) {
    if (!stream || !(stream instanceof MediaStream)) {
      return false;
    }
    const audioTracks = stream.getAudioTracks();
    if (audioTracks.length === 0) {
      return false;
    }
    // Stream is incoming if none of its tracks belong to our local mic
    return audioTracks.every((t) => !localMicTracks.has(t));
  }

  function patchMediaElementSrcObject() {
    if (!originals.mediaElementSrcObject) {
      return;
    }

    Object.defineProperty(HTMLMediaElement.prototype, 'srcObject', {
      configurable: true,
      enumerable: true,
      get() {
        if (activeMediaElements.has(this)) {
          return activeMediaElements.get(this).rawStream;
        }
        return originals.mediaElementSrcObject.get.call(this);
      },
      set(stream) {
        if (!isIncomingStream(stream)) {
          activeMediaElements.delete(this);
          originals.mediaElementSrcObject.set.call(this, stream);
          return;
        }

        const rawStream = stream;
        const element = this;
        activeMediaElements.set(element, { rawStream, cleanStream: null });

        const isCurrentAssignment = () => activeMediaElements.get(element)?.rawStream === rawStream;

        const attachRawPlayback = () => {
          if (isCurrentAssignment()) {
            originals.mediaElementSrcObject.set.call(element, rawStream);
          }
        };

        ensureEnabled()
          .then((ready) => {
            if (!isCurrentAssignment()) {
              return undefined;
            }

            if (!ready || !state.rxEnabled || state.rxStatus !== 'active') {
              attachRawPlayback();
              return undefined;
            }

            return rxPipeline.processInputStream(rawStream).then((processed) => {
              if (!isCurrentAssignment()) {
                return;
              }

              activeMediaElements.set(element, { rawStream, cleanStream: processed.cleanStream });
              originals.mediaElementSrcObject.set.call(element, processed.cleanStream);
              publish('incoming: attached DTLN-denoised stream to media element');
            });
          })
          .catch((err) => {
            console.error(`${LOG_PREFIX} RX processing failed for media element`, err);
            attachRawPlayback();
          });
      },
    });
  }

  async function denoiseActiveMediaElements() {
    if (!state.enabled || !state.rxEnabled || state.rxStatus !== 'active') {
      return;
    }

    for (const [element, { rawStream }] of activeMediaElements.entries()) {
      if (rawStream && rawStream.active) {
        try {
          const processed = await rxPipeline.processInputStream(rawStream);
          activeMediaElements.set(element, { rawStream, cleanStream: processed.cleanStream });
          originals.mediaElementSrcObject.set.call(element, processed.cleanStream);
          publish('incoming: attached DTLN-denoised stream to media element');
        } catch (err) {
          console.error(`${LOG_PREFIX} failed to denoise active media element`, err);
        }
      }
    }
  }

  function restoreMediaElements() {
    for (const [element, { rawStream }] of activeMediaElements.entries()) {
      try {
        originals.mediaElementSrcObject.set.call(element, rawStream);
      } catch (err) {
        console.warn(`${LOG_PREFIX} failed to restore media element to raw stream`, err);
      }
    }
  }

  function installPatches() {
    if (state.installed || !originals.getUserMedia || !originals.RTCPeerConnection) {
      return;
    }

    navigator.mediaDevices.getUserMedia = getCleanUserMedia;
    PatchedRTCPeerConnection.prototype = originals.RTCPeerConnection.prototype;
    window.RTCPeerConnection = PatchedRTCPeerConnection;
    patchMediaElementSrcObject();
    state.installed = true;
  }

  let enablePromise = null;

  async function ensureEnabled() {
    if (state.enabled && state.status === 'active') {
      return true;
    }

    try {
      await enable();
      return state.status === 'active';
    } catch (_error) {
      return false;
    }
  }

  async function enable() {
    if (enablePromise) {
      return enablePromise;
    }

    enablePromise = (async () => {
      installPatches();
      state.enabled = true;
      state.processing = false;
      state.failure = null;
      state.status = 'starting';
      state.txStatus = state.txEnabled ? 'starting' : 'idle';
      state.rxStatus = state.rxEnabled ? 'starting' : 'idle';
      publish('extension: auto-starting DTLN layers');

      try {
        txPipeline.stop();
        rxPipeline.stop();
        txPipeline = createPipeline('outgoing');
        rxPipeline = createPipeline('incoming');

        const inits = [];
        if (state.txEnabled) {
          inits.push(txPipeline.initialize());
        }
        if (state.rxEnabled) {
          inits.push(rxPipeline.initialize());
        }

        await Promise.all(inits);

        if (state.txEnabled) {
          state.txStatus = 'active';
        }
        if (state.rxEnabled) {
          state.rxStatus = 'active';
        }
        updateOverallStatus();

        publish(`extension: DTLN active with ${DTLN_LAYER_COUNT} layers`);
        await replaceExistingSenders();
        await denoiseActiveMediaElements();
      } catch (error) {
        enablePromise = null;
        state.status = 'inactive';
        state.processing = false;
        state.failure = error.message;
        console.error(`${LOG_PREFIX} enable failed — noise cancellation INACTIVE`, error);
        publish(`extension: ${error.message}`, {
          type: 'error',
          reason: error.message,
        });
      }
    })();

    return enablePromise;
  }

  async function disable() {
    state.enabled = false;
    state.status = 'idle';
    state.txStatus = 'idle';
    state.rxStatus = 'idle';
    state.processing = false;
    state.txProcessing = false;
    state.rxProcessing = false;
    state.failure = null;

    await restoreSenders();
    restoreMediaElements();

    txPipeline.stop();
    rxPipeline.stop();
    enablePromise = null;
    publish('extension: disabled for this tab');
  }

  async function listDevices() {
    await refreshAvailableDevices();
    publish('extension: microphone devices refreshed', {
      selectedDeviceId: state.selectedDeviceId,
      devices: state.devices,
    });
  }

  async function selectDevice(deviceId) {
    await refreshAvailableDevices();

    if (!deviceId) {
      state.selectedDeviceId = '';
      publish('extension: using the call page microphone', {
        selectedDeviceId: '',
        devices: state.devices,
      });
      return;
    }

    const match = state.devices.find((device) => device.deviceId === deviceId);
    if (!match) {
      publish('extension: selected microphone was not found', {
        type: 'error',
        selectedDeviceId: state.selectedDeviceId,
        devices: state.devices,
      });
      return;
    }

    state.selectedDeviceId = deviceId;

    try {
      if (state.enabled && state.txEnabled) {
        await switchLiveMicrophone();
      }
      publish(`extension: microphone selected — ${match.label}`, {
        selectedDeviceId: state.selectedDeviceId,
        devices: state.devices,
      });
    } catch (error) {
      console.error(`${LOG_PREFIX} failed to switch microphone`, error);
      publish(`extension: could not switch microphone — ${error.message}`, {
        type: 'error',
        reason: error.message,
        selectedDeviceId: state.selectedDeviceId,
        devices: state.devices,
      });
    }
  }

  async function switchLiveMicrophone() {
    if (!originals.getUserMedia) {
      return;
    }

    const rawStream = await originals.getUserMedia(cleanAudioConstraints({ audio: true }));
    rawStream.getAudioTracks().forEach((track) => {
      localMicTracks.add(track);
      capturedRawTracks.add(track);
    });

    let outgoingTrack = rawStream.getAudioTracks()[0];
    if (!outgoingTrack) {
      throw new Error('Selected microphone produced no audio track');
    }

    if (state.enabled && state.txEnabled && state.txStatus === 'active') {
      const processed = await txPipeline.processOutgoingStream(rawStream);
      if (processed.cleanTrack) {
        processedTracks.add(processed.cleanTrack);
        localMicTracks.add(processed.cleanTrack);
        trackPairMap.set(processed.cleanTrack, processed.rawTrack);
        outgoingTrack = processed.cleanTrack;
      }
    }

    for (const pc of peerConnections) {
      for (const sender of pc.getSenders()) {
        if (sender.track?.kind !== 'audio') {
          continue;
        }

        senderToRawTrackMap.set(sender, rawStream.getAudioTracks()[0]);
        await sender.replaceTrack(outgoingTrack);
      }
    }
  }

  async function setToggles({ txEnabled, rxEnabled }) {
    if (typeof txEnabled === 'boolean' && txEnabled !== state.txEnabled) {
      state.txEnabled = txEnabled;
      if (!txEnabled) {
        await restoreSenders();
        txPipeline.stop();
        state.txStatus = 'idle';
        state.txProcessing = false;
      } else if (state.enabled) {
        state.txStatus = 'starting';
        try {
          await txPipeline.initialize();
          state.txStatus = 'active';
          await replaceExistingSenders();
        } catch (err) {
          state.txStatus = 'inactive';
          state.failure = err.message;
        }
      }
    }

    if (typeof rxEnabled === 'boolean' && rxEnabled !== state.rxEnabled) {
      state.rxEnabled = rxEnabled;
      if (!rxEnabled) {
        restoreMediaElements();
        rxPipeline.stop();
        state.rxStatus = 'idle';
        state.rxProcessing = false;
      } else if (state.enabled) {
        state.rxStatus = 'starting';
        try {
          await rxPipeline.initialize();
          state.rxStatus = 'active';
          await denoiseActiveMediaElements();
        } catch (err) {
          state.rxStatus = 'inactive';
          state.failure = err.message;
        }
      }
    }

    state.processing = state.txProcessing || state.rxProcessing;
    updateOverallStatus();
    publish('extension: toggles updated', { txEnabled: state.txEnabled, rxEnabled: state.rxEnabled });
  }

  window.addEventListener('message', (event) => {
    if (event.source !== window || event.data?.source !== FROM_EXTENSION) {
      return;
    }

    if (event.data.extensionBaseUrl) {
      state.assetBaseUrl = event.data.extensionBaseUrl;
    }

    if (event.data.command === PageCommand.INIT) {
      publish('extension: bridge initialized', { assetBaseUrl: state.assetBaseUrl });
    }

    if (event.data.command === PageCommand.ENABLE) {
      if (typeof event.data.deviceId === 'string') {
        state.selectedDeviceId = event.data.deviceId;
      }
      enable();
    }

    if (event.data.command === PageCommand.DISABLE) {
      disable();
    }

    if (event.data.command === PageCommand.SET_TOGGLES) {
      setToggles({ txEnabled: event.data.txEnabled, rxEnabled: event.data.rxEnabled });
    }

    if (event.data.command === PageCommand.STATUS) {
      publish('extension: status requested');
    }

    if (event.data.command === PageCommand.LIST_DEVICES) {
      listDevices();
    }

    if (event.data.command === PageCommand.SELECT_DEVICE) {
      selectDevice(event.data.deviceId);
    }
  });

  if (navigator.mediaDevices?.addEventListener) {
    navigator.mediaDevices.addEventListener('devicechange', () => {
      refreshAvailableDevices().then(() => {
        publish('extension: input devices changed', {
          selectedDeviceId: state.selectedDeviceId,
          devices: state.devices,
        });
      });
    });
  }

  installPatches();
  refreshAvailableDevices();
  publish('extension: bridge installed');
  enable();
}

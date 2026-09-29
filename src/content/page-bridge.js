import { AudioPipeline, mergeCallAudioConstraints } from '../audio/audio-pipeline.js';
import {
  LOG_PREFIX,
  PageCommand,
  PageMessageSource,
  WINDOW_BRIDGE_FLAG,
  WINDOW_STATE_KEY,
  duplexStatus,
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
        duplex: duplexStatus(window[WINDOW_STATE_KEY] ?? {}),
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

  function extensionAssetBaseUrl() {
    try {
      const moduleUrl = import.meta.url;
      if (moduleUrl) return new URL('./', moduleUrl).href;
    } catch (_error) {
      // A classic script build has no module URL. The content script sends the extension URL.
    }
    return '';
  }

  const state = {
    enabled: false,
    txEnabled: true,
    rxEnabled: true,
    selectedDeviceId: '',
    devices: [],
    assetBaseUrl: extensionAssetBaseUrl(),
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
    replaceTrack: null,
    mediaElementSrcObject: Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, 'srcObject'),
  };

  const peerConnections = new Set();
  const processedTracks = new WeakSet();
  const localMicTracks = new WeakSet();
  const remoteTracks = new WeakSet();
  const senderToRawTrackMap = new Map();
  const trackPairMap = new WeakMap();
  const rawToCleanTrack = new WeakMap();
  const activeMediaElements = new Map();
  const capturedRawTracks = new Set();
  const echoCancellationBefore = new WeakMap();

  let txPipeline = createPipeline('outgoing');
  let rxPipeline = createPipeline('incoming');

  function createPipeline(direction) {
    return new AudioPipeline({
      assetBaseUrl: state.assetBaseUrl,
      direction,
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
      duplex: duplexStatus(state),
      failure: state.failure,
      timestamp: Date.now(),
    };

    state.events = [event, ...state.events].slice(0, 15);
    console.info(LOG_PREFIX, message, {
      duplex: event.duplex,
      you: state.txProcessing ? 'live' : state.txStatus,
      them: state.rxProcessing ? 'live' : state.rxStatus,
      ...detail,
    });
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

  function rememberEchoCancellation(track, previous) {
    if (!track || echoCancellationBefore.has(track)) {
      return;
    }
    echoCancellationBefore.set(track, previous);
  }

  async function enableEchoCancellation(track, previous) {
    if (track?.kind !== 'audio' || typeof track.applyConstraints !== 'function') {
      return;
    }

    rememberEchoCancellation(
      track,
      previous !== undefined ? previous : track.getSettings?.().echoCancellation === true,
    );

    try {
      await track.applyConstraints({
        echoCancellation: true,
        noiseSuppression: false,
        autoGainControl: false,
      });
    } catch (_error) {
      // Some devices cannot change echo cancellation after the track is open.
    }
  }

  async function restoreEchoCancellation(track) {
    if (!echoCancellationBefore.has(track) || typeof track?.applyConstraints !== 'function') {
      return;
    }

    const previous = echoCancellationBefore.get(track);
    echoCancellationBefore.delete(track);

    try {
      await track.applyConstraints({ echoCancellation: previous });
    } catch (_error) {
      // The track may already have ended.
    }
  }

  async function restoreEchoCancellationOnLiveMics() {
    const tracks = new Set(capturedRawTracks);
    for (const pc of peerConnections) {
      for (const sender of pc.getSenders()) {
        if (sender.track?.kind !== 'audio') {
          continue;
        }
        tracks.add(senderToRawTrackMap.get(sender) || sender.track);
      }
    }
    await Promise.all([...tracks].map((track) => restoreEchoCancellation(track)));
  }

  async function enableEchoCancellationOnLiveMics() {
    const tracks = new Set(capturedRawTracks);
    for (const pc of peerConnections) {
      for (const sender of pc.getSenders()) {
        if (sender.track?.kind !== 'audio') {
          continue;
        }
        tracks.add(senderToRawTrackMap.get(sender) || sender.track);
      }
    }
    await Promise.all([...tracks].map((track) => enableEchoCancellation(track)));
  }

  function cleanAudioConstraints(constraints) {
    if (!audioRequested(constraints)) {
      return constraints;
    }

    const nextAudio = mergeCallAudioConstraints(constraints.audio, state.selectedDeviceId, state.enabled);

    return {
      ...constraints,
      audio: Object.keys(nextAudio).length > 0 ? nextAudio : true,
    };
  }

  // --- OUTGOING (TX) INTERCEPTION ---
  async function getCleanUserMedia(constraints) {
    const pageEchoCancellation =
      typeof constraints?.audio === 'object' && constraints.audio !== null
        ? constraints.audio.echoCancellation === true
        : false;
    const rawStream = await originals.getUserMedia(cleanAudioConstraints(constraints));
    if (state.enabled) {
      await Promise.all(
        rawStream.getAudioTracks().map((track) => enableEchoCancellation(track, pageEchoCancellation)),
      );
    }
    rawStream.getAudioTracks().forEach((t) => {
      localMicTracks.add(t);
      capturedRawTracks.add(t);
    });

    if (!audioRequested(constraints)) {
      return rawStream;
    }

    const ready = await ensureEnabled();
    if (!ready || !state.txEnabled || state.txStatus !== 'active') {
      return rawStream;
    }

    try {
      const processed = await txPipeline.processOutgoingStream(rawStream);
      const started = await processed.processingStarted;
      if (!started || !processed.cleanTrack) {
        processed.dispose();
        publish('outgoing: engine did not start processing; returning raw microphone', {
          pipeline: 'outgoing',
          type: 'inactive-passthrough',
        });
        return rawStream;
      }

      processedTracks.add(processed.cleanTrack);
      localMicTracks.add(processed.cleanTrack);
      rawStream.getAudioTracks().forEach((track) => {
        trackPairMap.set(processed.cleanTrack, track);
        rawToCleanTrack.set(track, processed.cleanTrack);
      });
      publish('outgoing: returned DeepFilterNet3 + RNNoise microphone stream', {
        pipeline: 'outgoing',
        type: 'stream-replaced',
        settings: processed.settings,
      });
      return rawStream;
    } catch (error) {
      state.txStatus = 'inactive';
      state.txProcessing = false;
      state.failure = error.message;
      updateOverallStatus();
      console.error(`${LOG_PREFIX} TX engine failed during getUserMedia — INACTIVE`, error);
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
    const started = await processed.processingStarted;
    if (!started) {
      processed.dispose();
      publish('outgoing: engine did not start processing; sending raw microphone', {
        pipeline: 'outgoing',
        type: 'inactive-passthrough',
      });
      return track;
    }

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

      senderToRawTrackMap.set(sender, trackPairMap.get(track) || track);
      const preparedCleanTrack = rawToCleanTrack.get(track);
      if (preparedCleanTrack && preparedCleanTrack !== track) {
        const replace = originals.replaceTrack
          ? originals.replaceTrack.call(sender, preparedCleanTrack)
          : sender.replaceTrack(preparedCleanTrack);
        replace.catch((error) => {
          publish(`outgoing: ${error.message}`, {
            pipeline: 'outgoing',
            type: 'error',
            reason: error.message,
          });
        });
        return sender;
      }
      ensureEnabled()
        .then((ready) => {
          if (!ready || !state.txEnabled || state.txStatus !== 'active') {
            return undefined;
          }
          return denoiseOutgoingTrack(track).then((cleanTrack) => {
            if (cleanTrack && cleanTrack !== track) {
              return originals.replaceTrack
                ? originals.replaceTrack.call(sender, cleanTrack)
                : sender.replaceTrack(cleanTrack);
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
          const rawTrack = senderToRawTrackMap.get(sender) || trackPairMap.get(sender.track) || sender.track;
          if (sender.track?.readyState === 'live' && txPipeline.graphs.has(sender.track.id)) {
            continue;
          }
          if (!rawTrack || rawTrack.readyState !== 'live') {
            continue;
          }
          senderToRawTrackMap.set(sender, rawTrack);
          const cleanTrack = await denoiseOutgoingTrack(rawTrack);
          if (cleanTrack && cleanTrack !== sender.track) {
            if (originals.replaceTrack) {
              await originals.replaceTrack.call(sender, cleanTrack);
            } else {
              await sender.replaceTrack(cleanTrack);
            }
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
            if (originals.replaceTrack) {
              await originals.replaceTrack.call(sender, rawTrack);
            } else {
              await sender.replaceTrack(rawTrack);
            }
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

  function isIncomingStream(stream) {
    if (!stream || !(stream instanceof MediaStream)) {
      return false;
    }
    const audioTracks = stream.getAudioTracks();
    if (audioTracks.length === 0) {
      return false;
    }
    return audioTracks.every((track) => !localMicTracks.has(track) && !processedTracks.has(track));
  }

  function attachPlayback(element, stream) {
    originals.mediaElementSrcObject.set.call(element, stream);
    if (typeof element.play === 'function') {
      element.play()?.catch?.(() => {});
    }
  }

  function disposeMediaEntry(entry) {
    if (!entry) {
      return;
    }
    const dispose = entry.dispose;
    entry.setBypass = null;
    entry.dispose = null;
    entry.graphKey = null;
    dispose?.();
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
        const previous = activeMediaElements.get(this);
        if (!isIncomingStream(stream)) {
          disposeMediaEntry(previous);
          activeMediaElements.delete(this);
          originals.mediaElementSrcObject.set.call(this, stream);
          return;
        }

        const rawStream = stream;
        const element = this;
        const generation = Symbol('incoming-audio');
        disposeMediaEntry(previous);
        const entry = {
          rawStream,
          generation,
          graphKey: null,
          dispose: null,
          setBypass: null,
          processingPromise: null,
          pending: true,
        };
        activeMediaElements.set(element, entry);

        attachPlayback(element, rawStream);
        txPipeline.setEchoReference(rawStream);

        const isCurrentAssignment = () => activeMediaElements.get(element)?.generation === generation;

        ensureEnabled()
          .then((ready) => {
            if (!isCurrentAssignment()) {
              return undefined;
            }
            if (!ready || !state.rxEnabled || state.rxStatus !== 'active') {
              entry.pending = false;
              return undefined;
            }

            if (entry.processingPromise) {
              return entry.processingPromise;
            }

            const processingPromise = rxPipeline
              .processMediaElement(element)
              .then(async (processed) => {
                const started = await processed.processingStarted;
                if (!isCurrentAssignment() || !state.enabled || !state.rxEnabled) {
                  processed.dispose?.();
                  return;
                }

                if (!started) {
                  processed.dispose?.();
                  console.warn(`${LOG_PREFIX} RX engine did not start processing; playing raw media element`);
                  return;
                }

                Object.assign(entry, {
                  graphKey: processed.graphKey,
                  dispose: processed.dispose,
                  setBypass: processed.setBypass,
                });
                publish('incoming: routed media element through DeepFilterNet3 + RNNoise');
              })
              .catch((error) => {
                console.error(`${LOG_PREFIX} RX processing failed for media element`, error);
              })
              .finally(() => {
                if (activeMediaElements.get(element)?.generation === generation) {
                  entry.pending = false;
                  if (entry.processingPromise === processingPromise) {
                    entry.processingPromise = null;
                  }
                }
              });

            entry.processingPromise = processingPromise;
            return processingPromise;
          })
          .catch((error) => {
            console.error(`${LOG_PREFIX} RX processing failed for media element`, error);
          });
      },
    });
  }

  function captureExistingIncomingMedia() {
    if (!originals.mediaElementSrcObject) {
      return;
    }

    document.querySelectorAll('audio, video').forEach((element) => {
      if (activeMediaElements.has(element)) {
        return;
      }
      const stream = originals.mediaElementSrcObject.get.call(element);
      if (isIncomingStream(stream)) {
        element.srcObject = stream;
      }
    });
  }

  async function denoiseActiveMediaElements() {
    if (!state.enabled || !state.rxEnabled || state.rxStatus !== 'active') {
      return;
    }

    for (const [element, entry] of activeMediaElements.entries()) {
      if (!entry?.rawStream?.active) {
        continue;
      }
      if (entry.pending || entry.processingPromise) {
        continue;
      }
      if (typeof entry.setBypass === 'function') {
        entry.setBypass(false);
        continue;
      }
      const setter = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, 'srcObject')?.set;
      setter?.call(element, entry.rawStream);
    }
  }

  function restoreMediaElements() {
    for (const [element, entry] of activeMediaElements.entries()) {
      try {
        attachPlayback(element, entry.rawStream);
        disposeMediaEntry(entry);
      } catch (error) {
        console.warn(`${LOG_PREFIX} failed to restore media element to raw stream`, error);
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

    if (window.RTCRtpSender?.prototype?.replaceTrack && !originals.replaceTrack) {
      originals.replaceTrack = window.RTCRtpSender.prototype.replaceTrack;
      window.RTCRtpSender.prototype.replaceTrack = async function replaceTrack(track) {
        if (
          !state.enabled ||
          !state.txEnabled ||
          track?.kind !== 'audio' ||
          processedTracks.has(track)
        ) {
          return originals.replaceTrack.call(this, track);
        }

        senderToRawTrackMap.set(this, trackPairMap.get(track) || track);
        const cleanTrack = await denoiseOutgoingTrack(track);
        return originals.replaceTrack.call(this, cleanTrack);
      };
    }

    state.installed = true;

    const resumeContexts = () => {
      txPipeline.context?.resume?.();
      rxPipeline.context?.resume?.();
    };
    window.addEventListener('pointerdown', resumeContexts, true);
    window.addEventListener('keydown', resumeContexts, true);
  }

  let enablePromise = null;

  async function ensureEnabled() {
    if (!state.enabled) {
      return false;
    }

    if (state.status === 'active') {
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
    if (state.enabled && state.status === 'active') {
      publish('extension: already active');
      return;
    }

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
      publish('extension: auto-starting DeepFilterNet3 + Jitsi RNNoise at 48 kHz');

      try {
        await enableEchoCancellationOnLiveMics();
        if (state.txEnabled) {
          txPipeline.stopGraphs();
          await txPipeline.initialize();
        }
        if (state.rxEnabled) {
          await rxPipeline.initialize();
        }

        if (state.txEnabled) {
          state.txStatus = 'active';
        }
        if (state.rxEnabled) {
          state.rxStatus = 'active';
        }
        updateOverallStatus();

        publish('extension: DeepFilterNet3 + Jitsi RNNoise active at 48 kHz');
        await replaceExistingSenders();
        captureExistingIncomingMedia();
        await denoiseActiveMediaElements();
      } catch (error) {
        state.status = 'inactive';
        state.processing = false;
        state.failure = error.message;
        console.error(`${LOG_PREFIX} enable failed — noise cancellation INACTIVE`, error);
        publish(`extension: ${error.message}`, {
          type: 'error',
          reason: error.message,
        });
      } finally {
        enablePromise = null;
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
    await restoreEchoCancellationOnLiveMics();
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
    await Promise.all(rawStream.getAudioTracks().map((track) => enableEchoCancellation(track, false)));
    rawStream.getAudioTracks().forEach((track) => {
      localMicTracks.add(track);
      capturedRawTracks.add(track);
    });

    let outgoingTrack = rawStream.getAudioTracks()[0];
    if (!outgoingTrack) {
      throw new Error('Selected microphone produced no audio track');
    }

    const rawOutgoing = outgoingTrack;
    if (state.enabled && state.txEnabled && state.txStatus === 'active') {
      const processed = await txPipeline.processOutgoingStream(rawStream);
      const started = await processed.processingStarted;
      if (started && processed.cleanTrack) {
        processedTracks.add(processed.cleanTrack);
        localMicTracks.add(processed.cleanTrack);
        trackPairMap.set(processed.cleanTrack, rawOutgoing);
        outgoingTrack = processed.cleanTrack;
      } else {
        processed.dispose();
      }
    }

    for (const pc of peerConnections) {
      for (const sender of pc.getSenders()) {
        if (sender.track?.kind !== 'audio') {
          continue;
        }

        senderToRawTrackMap.set(sender, rawOutgoing);
        if (originals.replaceTrack) {
          await originals.replaceTrack.call(sender, outgoingTrack);
        } else {
          await sender.replaceTrack(outgoingTrack);
        }
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
      txPipeline.assetBaseUrl = state.assetBaseUrl;
      rxPipeline.assetBaseUrl = state.assetBaseUrl;
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
}

import { createEngineWorklets, selfCheckEngine, ENGINE_SAMPLE_RATE } from './engine-loader.js';
import { LOG_PREFIX } from '../shared/constants.js';

export const DEFAULT_MIC_CONSTRAINTS = {};
export const ENGINE_SAMPLE_RATE_HZ = ENGINE_SAMPLE_RATE;

export function mergeCallAudioConstraints(audioConstraints, selectedDeviceId = '') {
  const requested =
    typeof audioConstraints === 'object' && audioConstraints !== null ? { ...audioConstraints } : {};

  requested.noiseSuppression = false;
  requested.autoGainControl = false;

  if (selectedDeviceId) {
    requested.deviceId = { exact: selectedDeviceId };
  }

  return requested;
}

export function createLiveAudioContext({ playback: _playback = false } = {}) {
  return new AudioContext({ sampleRate: ENGINE_SAMPLE_RATE, latencyHint: 'interactive' });
}

export const ENGINE_STAGE_COUNT = 2;
export const DTLN_LAYER_COUNT = ENGINE_STAGE_COUNT;
const GRAPH_PROCESSING_TIMEOUT_MS = 8000;
const HIGHPASS_HZ = 80;

export class AudioPipeline {
  constructor({ assetBaseUrl = '/', direction = 'outgoing', onEvent, layers: _layers = DTLN_LAYER_COUNT } = {}) {
    this.assetBaseUrl = assetBaseUrl;
    this.direction = direction;
    this.onEvent = onEvent ?? (() => {});
    this.layerCount = ENGINE_STAGE_COUNT;
    this.context = null;
    this.selfCheck = null;
    this.status = 'idle';
    this.failure = null;
    this.graphs = new Map();
    this.mediaSources = new WeakMap();
    this.mediaKeys = new WeakMap();
  }

  emit(type, extra = {}) {
    this.onEvent({
      pipeline: this.direction,
      type,
      status: this.status,
      failure: this.failure,
      ...extra,
    });
  }

  async releaseContext() {
    this.stopGraphs();
    const context = this.context;
    this.context = null;
    this.silentKeepAlive = null;
    this.echoWorkletReady = null;
    this.echoNodes = new Set();
    if (context) {
      try {
        await context.close();
      } catch (_error) {
        // The context is already closed.
      }
    }
  }

  async initialize() {
    await this.releaseContext();
    this.failure = null;
    this.status = 'starting';
    this.emit('self-check-started');

    try {
      this.selfCheck = await selfCheckEngine(this.assetBaseUrl);
      this.status = 'active';
      this.emit('self-check-passed', { selfCheck: this.selfCheck });
      return this.selfCheck;
    } catch (error) {
      this.status = 'inactive';
      this.failure = error.message;
      console.error(`${LOG_PREFIX} engine init failed — noise cancellation is INACTIVE`, error);
      this.emit('self-check-failed', { reason: error.message });
      throw error;
    }
  }

  async ensureContext({ playback = false } = {}) {
    if (!this.context) {
      this.context = createLiveAudioContext({ playback });
    }

    if (this.context.state === 'suspended') {
      await this.context.resume();
    }

    return this.context;
  }

  async createProcessorChain(context) {
    const processors = [];
    const processingLayers = new Set();
    let settleProcessingStarted;
    const processingStarted = new Promise((resolve) => {
      settleProcessingStarted = (started) => {
        if (!settleProcessingStarted) {
          return;
        }
        settleProcessingStarted = null;
        resolve(Boolean(started));
      };
    });

    const teardownProcessors = () => {
      processors.forEach((processor) => {
        try {
          processor.port.postMessage({ type: 'dispose' });
          processor.disconnect();
        } catch (_err) {
          // Ignore teardown errors
        }
      });
    };

    const { nodes } = await createEngineWorklets(context, { assetBaseUrl: this.assetBaseUrl });

    for (let index = 0; index < nodes.length; index += 1) {
      const layer = index + 1;
      const { node, ready, name } = nodes[index];

      node.port.addEventListener('message', (event) => {
        const data = event.data;
        if (data?.type === 'error') {
          this.status = 'inactive';
          this.failure = data.message;
          console.error(`${LOG_PREFIX} ${this.direction} ${name} error — INACTIVE`, data.message);
          this.emit('error', { reason: data.message, layer, engine: name });
          return;
        }

        if (data?.type === 'processing-started') {
          processingLayers.add(layer);
          if (processingLayers.size >= nodes.length) {
            settleProcessingStarted?.(true);
          }
          console.info(`${LOG_PREFIX} ${this.direction} ${name} processing`);
          this.emit('processing-started', { ...data, layer, engine: name, layers: nodes.length });
        }

        if (data?.type === 'ready') {
          console.info(`${LOG_PREFIX} ${this.direction} ${name} ready`);
          this.emit('layer-ready', { ...data, layer, engine: name, layers: nodes.length });
        }
      });

      try {
        await ready;
      } catch (error) {
        this.status = 'inactive';
        this.failure = error.message;
        node.port.postMessage({ type: 'dispose' });
        node.disconnect();
        teardownProcessors();
        settleProcessingStarted?.(false);
        console.error(`${LOG_PREFIX} ${this.direction} ${name} failed to start — INACTIVE`, error);
        this.emit('error', { reason: error.message, layer, engine: name });
        throw error;
      }

      processors.push(node);
    }

    const highpass = context.createBiquadFilter();
    highpass.type = 'highpass';
    highpass.frequency.value = HIGHPASS_HZ;

    const processingTimer = setTimeout(() => {
      settleProcessingStarted?.(false);
    }, GRAPH_PROCESSING_TIMEOUT_MS);

    return {
      processors,
      highpass,
      processingStarted,
      processingTimer,
      settleProcessingStarted,
      teardownProcessors,
    };
  }

  wireGraph(source, highpass, processors, output, { keepAlive = null, bypass = false } = {}) {
    try {
      source.disconnect();
    } catch (_err) {
      // Not connected yet
    }
    try {
      highpass.disconnect();
    } catch (_err) {
      // Not connected yet
    }
    processors.forEach((processor) => {
      try {
        processor.disconnect();
      } catch (_err) {
        // Not connected yet
      }
    });
    try {
      keepAlive?.disconnect();
    } catch (_err) {
      // Optional keep-alive
    }

    if (bypass) {
      source.connect(output);
      return;
    }

    source.connect(highpass);
    let current = highpass;
    processors.forEach((node) => {
      current.connect(node);
      current = node;
    });
    current.connect(output);
    if (keepAlive) {
      current.connect(keepAlive);
      keepAlive.connect(source.context.destination);
    }
  }

  async attachDenoiseGraph(rawStream, emptyTrackMessage) {
    if (this.status !== 'active') {
      const reason = this.failure ?? 'Noise cancellation is not active';
      console.error(`${LOG_PREFIX} refusing to claim denoised audio: ${reason}`);
      this.emit('bypass-blocked', { reason });
      throw new Error(reason);
    }

    const context = await this.ensureContext({ playback: false });
    const clonedTracks = rawStream.getAudioTracks().map((track) => track.clone());
    const graphStream = new MediaStream(clonedTracks);
    const rawTrack = graphStream.getAudioTracks()[0];

    if (!rawTrack) {
      clonedTracks.forEach((track) => track.stop());
      throw new Error(emptyTrackMessage);
    }

    const settings = typeof rawTrack.getSettings === 'function' ? rawTrack.getSettings() : {};
    this.emit('stream-settings', { settings, layers: this.layerCount });
    console.info(`${LOG_PREFIX} ${this.direction} capture settings`, settings);

    const chain = await this.createProcessorChain(context);
    const source = context.createMediaStreamSource(graphStream);
    const destination = context.createMediaStreamDestination();
    const keepAlive = context.createGain();
    keepAlive.gain.value = 0;

    this.wireGraph(source, chain.highpass, chain.processors, destination, { keepAlive });

    const cleanTrack = destination.stream.getAudioTracks()[0];

    if (!cleanTrack) {
      clearTimeout(chain.processingTimer);
      source.disconnect();
      chain.teardownProcessors();
      clonedTracks.forEach((track) => track.stop());
      chain.settleProcessingStarted?.(false);
      throw new Error('Denoise graph did not produce an output track');
    }

    const graphKey = cleanTrack.id || rawTrack.id;
    const graph = {
      rawStream,
      rawTrack,
      cleanTrack,
      source,
      processors: chain.processors,
      highpass: chain.highpass,
      destination,
      keepAlive,
      clonedTracks,
      processingTimer: chain.processingTimer,
      settleProcessingStarted: chain.settleProcessingStarted,
    };
    this.graphs.set(graphKey, graph);

    rawTrack.addEventListener(
      'ended',
      () => {
        this.disposeGraph(graphKey);
      },
      { once: true },
    );

    this.emit('stream-replaced', { settings, layers: this.layerCount });

    return {
      rawStream,
      cleanStream: destination.stream,
      rawTrack,
      cleanTrack,
      settings,
      graphKey,
      processingStarted: chain.processingStarted,
      dispose: () => this.disposeGraph(graphKey),
    };
  }

  async processOutgoingStream(rawStream) {
    return this.attachDenoiseGraph(rawStream, 'getUserMedia returned no audio track');
  }

  async processInputStream(rawStream) {
    return this.attachDenoiseGraph(rawStream, 'Incoming stream has no audio track');
  }

  async processMediaElement(element) {
    if (this.status !== 'active') {
      const reason = this.failure ?? 'Noise cancellation is not active';
      throw new Error(reason);
    }

    const context = await this.ensureContext({ playback: true });
    const existingKey = this.mediaKeys.get(element);
    if (existingKey && this.graphs.has(existingKey)) {
      const existing = this.graphs.get(existingKey);
      existing.setBypass?.(false);
      return {
        graphKey: existingKey,
        processingStarted: Promise.resolve(true),
        dispose: () => existing.setBypass?.(true),
        setBypass: existing.setBypass,
      };
    }

    let source = this.mediaSources.get(element);
    if (!source) {
      try {
        source = context.createMediaElementSource(element);
      } catch (_error) {
        const stream = element.srcObject;
        if (!(stream instanceof MediaStream) || stream.getAudioTracks().length === 0) {
          throw new Error('Cannot tap incoming media element audio');
        }
        source = context.createMediaStreamSource(
          new MediaStream(stream.getAudioTracks().map((track) => track.clone())),
        );
        element.muted = true;
      }
      this.mediaSources.set(element, source);
    }

    const chain = await this.createProcessorChain(context);
    const setBypass = (bypass) => {
      this.wireGraph(source, chain.highpass, chain.processors, context.destination, { bypass });
    };
    setBypass(false);

    const graphKey = `media:${element.tagName}:${Math.random().toString(36).slice(2)}`;
    this.mediaKeys.set(element, graphKey);
    this.graphs.set(graphKey, {
      source,
      processors: chain.processors,
      highpass: chain.highpass,
      element,
      keepSource: true,
      processingTimer: chain.processingTimer,
      settleProcessingStarted: chain.settleProcessingStarted,
      setBypass,
    });

    this.emit('stream-replaced', { layers: this.layerCount, tap: 'media-element' });

    return {
      graphKey,
      processingStarted: chain.processingStarted,
      dispose: () => setBypass(true),
      setBypass,
    };
  }

  disposeGraph(key) {
    const graph = this.graphs.get(key);
    if (!graph) {
      return;
    }

    try {
      clearTimeout(graph.processingTimer);
      graph.settleProcessingStarted?.(false);
      if (graph.keepSource) {
        graph.setBypass?.(true);
        this.graphs.delete(key);
        return;
      }
      graph.source?.disconnect();
      graph.highpass?.disconnect();
      graph.keepAlive?.disconnect();
      const processors = graph.processors ?? (graph.processor ? [graph.processor] : []);
      processors.forEach((processor) => {
        processor?.port.postMessage({ type: 'dispose' });
        processor?.disconnect();
      });
      graph.clonedTracks?.forEach((track) => {
        try {
          track.stop();
        } catch (_stopErr) {
          // Ignore clone teardown errors
        }
      });
    } catch (_err) {
      // Ignore disconnect errors during teardown
    }

    this.graphs.delete(key);
  }

  stopGraphs() {
    for (const key of Array.from(this.graphs.keys())) {
      this.disposeGraph(key);
    }
  }

  stop() {
    void this.releaseContext();
    this.status = 'idle';
    this.failure = null;
  }
}

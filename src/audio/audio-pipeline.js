import { createEngineWorklets, selfCheckEngine, ENGINE_SAMPLE_RATE } from './engine-loader.js';
import { LOG_PREFIX } from '../shared/constants.js';

export const DEFAULT_MIC_CONSTRAINTS = {};
export const ENGINE_SAMPLE_RATE_HZ = ENGINE_SAMPLE_RATE;

export function mergeCallAudioConstraints(audioConstraints, selectedDeviceId = '', echoCancellation = true) {
  const requested =
    typeof audioConstraints === 'object' && audioConstraints !== null ? { ...audioConstraints } : {};

  if (echoCancellation) {
    requested.echoCancellation = true;
  }
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
const ECHO_WORKLET_NAME = 'echo-cancel-processor';
const ECHO_WORKLET_SOURCE = `
class EchoCancelProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.length = 2048;
    this.weights = new Float32Array(this.length);
    this.history = new Float32Array(this.length);
    this.mu = 0.12;
    this.farEnergy = 0.0001;
    this.nearEnergy = 0.0001;
  }

  process(inputs, outputs) {
    const near = inputs[0] && inputs[0][0];
    const far = inputs[1] && inputs[1][0];
    const output = outputs[0] && outputs[0][0];
    if (!near || !output) return true;
    if (!far) {
      output.set(near);
      return true;
    }

    for (let index = 0; index < near.length; index += 1) {
      this.history.copyWithin(0, 1);
      this.history[this.length - 1] = far[index] || 0;

      let predicted = 0;
      let power = 0.0001;
      for (let tap = 0; tap < this.length; tap += 1) {
        const sample = this.history[tap];
        predicted += this.weights[tap] * sample;
        power += sample * sample;
      }

      const error = near[index] - predicted;
      const farPower = (far[index] || 0) * (far[index] || 0);
      const nearPower = near[index] * near[index];
      this.farEnergy = 0.97 * this.farEnergy + 0.03 * farPower;
      this.nearEnergy = 0.97 * this.nearEnergy + 0.03 * nearPower;

      const farActive = this.farEnergy > 0.000001;
      const doubletalk = farActive && this.nearEnergy > this.farEnergy * 1.5;
      if (farActive && !doubletalk) {
        const gain = (this.mu * error) / power;
        for (let tap = 0; tap < this.length; tap += 1) {
          this.weights[tap] += gain * this.history[tap];
        }
      }

      let cleaned = error;
      if (farActive && !doubletalk && predicted * predicted > error * error * 4) {
        cleaned *= 0.2;
      }
      output[index] = cleaned;
    }
    return true;
  }
}
registerProcessor('${ECHO_WORKLET_NAME}', EchoCancelProcessor);
`;

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
    this.echoNodes = new Set();
    this.echoReference = null;
    this.echoWorkletReady = null;
  }

  setEchoReference(stream) {
    if (this.direction !== 'outgoing') {
      return;
    }
    this.echoReference = stream instanceof MediaStream ? stream : null;
    this.echoNodes.forEach((node) => this.connectEchoReference(node));
  }

  async ensureEchoWorklet(context) {
    if (!this.echoWorkletReady) {
      const url = URL.createObjectURL(new Blob([ECHO_WORKLET_SOURCE], { type: 'text/javascript' }));
      this.echoWorkletReady = context.audioWorklet.addModule(url).finally(() => URL.revokeObjectURL(url));
    }
    await this.echoWorkletReady;
    const node = new AudioWorkletNode(context, ECHO_WORKLET_NAME, {
      numberOfInputs: 2,
      numberOfOutputs: 1,
      outputChannelCount: [1],
      channelCount: 1,
      channelCountMode: 'explicit',
    });
    this.echoNodes.add(node);
    this.connectEchoReference(node);
    return node;
  }

  connectEchoReference(node) {
    try {
      node.echoReferenceSource?.disconnect();
    } catch (_error) {
      // Already disconnected.
    }
    node.echoReferenceSource = null;
    const track = this.echoReference?.getAudioTracks?.().find((item) => item.readyState === 'live');
    if (!track) {
      return;
    }
    const source = node.context.createMediaStreamSource(new MediaStream([track]));
    source.connect(node, 0, 1);
    node.echoReferenceSource = source;
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

  async initialize() {
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

    if (!this.silentKeepAlive) {
      const gain = this.context.createGain();
      gain.gain.value = 0;
      const silent = this.context.createConstantSource();
      silent.connect(gain);
      gain.connect(this.context.destination);
      silent.start();
      this.silentKeepAlive = { gain, silent };
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
    if (this.direction === 'outgoing') {
      chain.processors.push(await this.ensureEchoWorklet(context));
    }

    this.wireGraph(source, chain.highpass, chain.processors, destination);

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
        processingStarted: existing.processingStarted ?? Promise.resolve(existing.heard === true),
        dispose: () => this.disposeGraph(existingKey),
        setBypass: existing.setBypass,
      };
    }

    const stream = element.srcObject;
    if (!(stream instanceof MediaStream) || stream.getAudioTracks().length === 0) {
      throw new Error('Cannot tap incoming media element audio');
    }

    const wasMuted = element.muted;
    const clonedTracks = stream.getAudioTracks().map((track) => track.clone());
    const source = context.createMediaStreamSource(new MediaStream(clonedTracks));
    const outputGain = context.createGain();
    outputGain.gain.value = 0;
    outputGain.connect(context.destination);

    const chain = await this.createProcessorChain(context);
    const graphKey = `media:${element.tagName}:${Math.random().toString(36).slice(2)}`;

    const setBypass = (bypass) => {
      const graph = this.graphs.get(graphKey);
      if (!graph) {
        return;
      }
      if (bypass) {
        graph.outputGain.gain.value = 0;
        if (this.mediaKeys.get(element) === graphKey) {
          element.muted = graph.wasMuted;
        }
        return;
      }
      this.wireGraph(source, chain.highpass, chain.processors, outputGain);
      if (graph.heard) {
        element.muted = true;
        graph.outputGain.gain.value = 1;
      }
    };

    const graph = {
      source,
      processors: chain.processors,
      highpass: chain.highpass,
      element,
      outputGain,
      wasMuted,
      clonedTracks,
      heard: false,
      keepSource: true,
      processingTimer: chain.processingTimer,
      settleProcessingStarted: chain.settleProcessingStarted,
      processingStarted: null,
      setBypass,
    };
    this.mediaKeys.set(element, graphKey);
    this.graphs.set(graphKey, graph);
    setBypass(false);

    const processingStarted = chain.processingStarted.then((started) => {
      if (!started || !this.graphs.has(graphKey)) {
        return false;
      }
      graph.heard = true;
      if (this.mediaKeys.get(element) === graphKey) {
        element.muted = true;
        outputGain.gain.value = 1;
      }
      return true;
    });

    graph.processingStarted = processingStarted;
    this.emit('stream-replaced', { layers: this.layerCount, tap: 'media-element' });

    return {
      graphKey,
      processingStarted,
      dispose: () => this.disposeGraph(graphKey),
      setBypass,
    };
  }

  releaseMediaGraph(key, graph) {
    try {
      graph.outputGain?.disconnect();
      graph.source?.disconnect();
      graph.highpass?.disconnect();
      const processors = graph.processors ?? [];
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
      if (graph.element && this.mediaKeys.get(graph.element) === key) {
        graph.element.muted = graph.wasMuted ?? false;
        this.mediaKeys.delete(graph.element);
      }
    } catch (_err) {
      // Ignore disconnect errors during teardown
    }
    this.graphs.delete(key);
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
        this.releaseMediaGraph(key, graph);
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
    this.stopGraphs();
    this.status = 'idle';
    this.failure = null;
  }
}

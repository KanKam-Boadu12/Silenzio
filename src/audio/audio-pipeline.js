import { createDtlnWorklet, selfCheckDtln } from './dtln-loader.js';
import { DTLN_SAMPLE_RATE } from './dtln-processor.js';
import { LOG_PREFIX } from '../shared/constants.js';

export const DEFAULT_MIC_CONSTRAINTS = {
  channelCount: 1,
  sampleRate: DTLN_SAMPLE_RATE,
  echoCancellation: false,
  noiseSuppression: false,
  autoGainControl: false,
};

export const DTLN_LAYER_COUNT = 2;

export class AudioPipeline {
  constructor({ assetBaseUrl = '/', direction = 'outgoing', onEvent, layers = DTLN_LAYER_COUNT } = {}) {
    this.assetBaseUrl = assetBaseUrl;
    this.direction = direction;
    this.onEvent = onEvent ?? (() => {});
    this.layerCount = Math.max(1, Number(layers) || DTLN_LAYER_COUNT);
    this.context = null;
    this.selfCheck = null;
    this.status = 'idle';
    this.failure = null;
    this.graphs = new Map();
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
      this.selfCheck = await selfCheckDtln(this.assetBaseUrl);
      this.status = 'active';
      this.emit('self-check-passed', { selfCheck: this.selfCheck });
      return this.selfCheck;
    } catch (error) {
      this.status = 'inactive';
      this.failure = error.message;
      console.error(`${LOG_PREFIX} DTLN init failed — noise cancellation is INACTIVE`, error);
      this.emit('self-check-failed', { reason: error.message });
      throw error;
    }
  }

  async ensureContext() {
    if (!this.context) {
      this.context = new AudioContext({ sampleRate: DTLN_SAMPLE_RATE });
    }

    if (this.context.state === 'suspended') {
      await this.context.resume();
    }

    return this.context;
  }

  async attachDenoiseGraph(rawStream, emptyTrackMessage) {
    if (this.status !== 'active') {
      const reason = this.failure ?? 'DTLN is not active';
      console.error(`${LOG_PREFIX} refusing to claim denoised audio: ${reason}`);
      this.emit('bypass-blocked', { reason });
      throw new Error(reason);
    }

    const context = await this.ensureContext();
    const rawTrack = rawStream.getAudioTracks()[0];

    if (!rawTrack) {
      throw new Error(emptyTrackMessage);
    }

    const settings = typeof rawTrack.getSettings === 'function' ? rawTrack.getSettings() : {};
    this.emit('stream-settings', { settings, layers: this.layerCount });
    console.info(`${LOG_PREFIX} ${this.direction} capture settings`, settings);
    console.info(`${LOG_PREFIX} ${this.direction} stacking ${this.layerCount} DTLN layers`);

    const processors = [];

    for (let index = 0; index < this.layerCount; index += 1) {
      const layer = index + 1;
      const { node, ready } = await createDtlnWorklet(context, {
        assetBaseUrl: this.assetBaseUrl,
        bypassUntilReady: false,
      });

      node.port.onmessage = (event) => {
        const data = event.data;
        if (data?.type === 'error') {
          this.status = 'inactive';
          this.failure = data.message;
          console.error(`${LOG_PREFIX} ${this.direction} layer ${layer} error — INACTIVE`, data.message, data.stack);
          this.emit('error', { reason: data.message, layer });
          return;
        }

        if (data?.type === 'processing-started') {
          console.info(`${LOG_PREFIX} ${this.direction} layer ${layer}/${this.layerCount} processing`);
          this.emit('processing-started', { ...data, layer, layers: this.layerCount });
        }

        if (data?.type === 'ready') {
          console.info(`${LOG_PREFIX} ${this.direction} layer ${layer}/${this.layerCount} ready`);
          this.emit('layer-ready', { ...data, layer, layers: this.layerCount });
        }
      };

      try {
        await ready;
      } catch (error) {
        this.status = 'inactive';
        this.failure = error.message;
        node.port.postMessage({ type: 'dispose' });
        node.disconnect();
        processors.forEach((processor) => {
          try {
            processor.port.postMessage({ type: 'dispose' });
            processor.disconnect();
          } catch (_err) {
            // Ignore teardown errors
          }
        });
        console.error(`${LOG_PREFIX} ${this.direction} layer ${layer} failed to start — INACTIVE`, error);
        this.emit('error', { reason: error.message, layer });
        throw error;
      }

      processors.push(node);
    }

    const source = context.createMediaStreamSource(rawStream);
    const destination = context.createMediaStreamDestination();
    let current = source;
    processors.forEach((node) => {
      current.connect(node);
      current = node;
    });
    current.connect(destination);

    const cleanTrack = destination.stream.getAudioTracks()[0];

    if (!cleanTrack) {
      throw new Error('DTLN graph did not produce an output track');
    }

    const graph = { rawStream, rawTrack, cleanTrack, source, processors, destination };
    const graphKey = cleanTrack.id || rawTrack.id;
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
    };
  }

  async processOutgoingStream(rawStream) {
    return this.attachDenoiseGraph(rawStream, 'getUserMedia returned no audio track');
  }

  async processInputStream(rawStream) {
    return this.attachDenoiseGraph(rawStream, 'Incoming stream has no audio track');
  }

  disposeGraph(key) {
    const graph = this.graphs.get(key);
    if (!graph) {
      return;
    }

    try {
      graph.source?.disconnect();
      const processors = graph.processors ?? (graph.processor ? [graph.processor] : []);
      processors.forEach((processor) => {
        processor?.port.postMessage({ type: 'dispose' });
        processor?.disconnect();
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

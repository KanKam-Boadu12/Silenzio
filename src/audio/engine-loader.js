import { LOG_PREFIX } from '../shared/constants.js';

export const ENGINE_SAMPLE_RATE = 48000;
export const DFN_PROCESSOR_NAME = 'deepfilter-audio-processor';
export const RNNOISE_PROCESSOR_NAME = 'NoiseSuppressorWorklet';
export const DFN_SUPPRESSION_LEVEL = 90;

const READY_TIMEOUT_MS = 30000;
const SELF_CHECK_TIMEOUT_MS = 15000;
const MIN_ASSET_BYTES = 1024;

function engineUrls(assetBaseUrl) {
  const base = assetBaseUrl.endsWith('/') ? assetBaseUrl : `${assetBaseUrl}/`;
  return {
    dfnProcessor: new URL('engine/dfn-processor.js', base).href,
    dfnWasm: new URL('engine/df_bg.wasm', base).href,
    dfnModel: new URL('engine/DeepFilterNet3_onnx.tar.gz', base).href,
    rnnoiseWorklet: new URL('engine/rnnoise-worklet.js', base).href,
  };
}

async function assertAsset(url, label) {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`${label} missing (${response.status}): ${url}`);
  }
  const bytes = await response.arrayBuffer();
  if (bytes.byteLength < MIN_ASSET_BYTES) {
    throw new Error(`${label} is empty or truncated (${bytes.byteLength} bytes): ${url}`);
  }
  return bytes;
}

function waitForWorkletMessage(node, predicate, timeoutMs, timeoutLabel) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(timeoutLabel));
    }, timeoutMs);

    const onMessage = (event) => {
      const data = event.data;
      if (data?.type === 'error') {
        cleanup();
        reject(new Error(data.message || 'Engine worklet reported an error'));
        return;
      }
      if (predicate(data)) {
        cleanup();
        resolve(data);
      }
    };

    const cleanup = () => {
      clearTimeout(timer);
      node.port.removeEventListener('message', onMessage);
    };

    node.port.addEventListener('message', onMessage);
    node.port.start();
  });
}

export async function verifyEngineAssets(assetBaseUrl) {
  const urls = engineUrls(assetBaseUrl);
  const [dfnProcessor, dfnWasm, dfnModel, rnnoiseWorklet] = await Promise.all([
    assertAsset(urls.dfnProcessor, 'DeepFilterNet3 worklet'),
    assertAsset(urls.dfnWasm, 'DeepFilterNet3 wasm'),
    assertAsset(urls.dfnModel, 'DeepFilterNet3 model'),
    assertAsset(urls.rnnoiseWorklet, 'Jitsi RNNoise worklet'),
  ]);

  return {
    urls,
    sizes: {
      dfnProcessor: dfnProcessor.byteLength,
      dfnWasm: dfnWasm.byteLength,
      dfnModel: dfnModel.byteLength,
      rnnoiseWorklet: rnnoiseWorklet.byteLength,
    },
    dfnWasm,
    dfnModel,
  };
}

export async function createEngineWorklets(context, { assetBaseUrl } = {}) {
  const inventory = await verifyEngineAssets(assetBaseUrl);
  const wasmModule = await WebAssembly.compile(inventory.dfnWasm);

  await context.audioWorklet.addModule(inventory.urls.dfnProcessor);
  await context.audioWorklet.addModule(inventory.urls.rnnoiseWorklet);

  const dfnNode = new AudioWorkletNode(context, DFN_PROCESSOR_NAME, {
    channelCount: 1,
    channelCountMode: 'explicit',
    numberOfInputs: 1,
    numberOfOutputs: 1,
    outputChannelCount: [1],
    processorOptions: {
      wasmModule,
      modelBytes: inventory.dfnModel,
      suppressionLevel: DFN_SUPPRESSION_LEVEL,
    },
  });
  const dfnReady = waitForWorkletMessage(
    dfnNode,
    (data) => data?.type === 'ready',
    READY_TIMEOUT_MS,
    'Timed out waiting for DeepFilterNet3 to initialize',
  );

  const rnnoiseNode = new AudioWorkletNode(context, RNNOISE_PROCESSOR_NAME, {
    channelCount: 1,
    channelCountMode: 'explicit',
    numberOfInputs: 1,
    numberOfOutputs: 1,
    outputChannelCount: [1],
  });
  const rnnoiseReady = waitForWorkletMessage(
    rnnoiseNode,
    (data) => data?.type === 'ready',
    READY_TIMEOUT_MS,
    'Timed out waiting for Jitsi RNNoise to initialize',
  );

  return {
    nodes: [
      { node: dfnNode, ready: dfnReady, name: 'DeepFilterNet3' },
      { node: rnnoiseNode, ready: rnnoiseReady, name: 'Jitsi RNNoise' },
    ],
    sizes: inventory.sizes,
  };
}

export async function selfCheckEngine(assetBaseUrl) {
  const inventory = await verifyEngineAssets(assetBaseUrl);
  console.info(`${LOG_PREFIX} engine assets present`, inventory.sizes);
  return { sampleRate: ENGINE_SAMPLE_RATE, assets: inventory.sizes };
}

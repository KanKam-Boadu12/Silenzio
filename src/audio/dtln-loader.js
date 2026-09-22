import { DTLN_FRAME_SIZE, DTLN_PROCESSOR_NAME, DTLN_SAMPLE_RATE } from './dtln-processor.js';
import { LOG_PREFIX } from '../shared/constants.js';
const READY_TIMEOUT_MS = 30000;
const SELF_CHECK_TIMEOUT_MS = 15000;
const MIN_ASSET_BYTES = 1024;

const SIMD_PROBE = new Uint8Array([
  0, 97, 115, 109, 1, 0, 0, 0, 1, 5, 1, 96, 0, 1, 123, 3, 2, 1, 0, 10, 15, 1, 13, 0, 65, 1, 253, 15, 65, 2, 253, 15, 253,
  128, 2, 11,
]);

export { DTLN_FRAME_SIZE, DTLN_PROCESSOR_NAME, DTLN_SAMPLE_RATE };

export function dtlnAssetUrls(assetBaseUrl) {
  const base = assetBaseUrl.endsWith('/') ? assetBaseUrl : `${assetBaseUrl}/`;
  return {
    processor: new URL('dtln/dtln-processor.js', base).href,
    wasmInternal: new URL('dtln/litert_wasm_internal.wasm', base).href,
    wasmCompat: new URL('dtln/litert_wasm_compat_internal.wasm', base).href,
    model1: new URL('dtln/model_quant_1.tflite', base).href,
    model2: new URL('dtln/model_quant_2.tflite', base).href,
  };
}

export function detectLiteRtVariant() {
  try {
    return WebAssembly.validate(SIMD_PROBE) ? 'relaxed' : 'compat';
  } catch {
    return 'compat';
  }
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

export async function verifyDtlnAssets(assetBaseUrl) {
  const urls = dtlnAssetUrls(assetBaseUrl);
  const [processor, wasmInternal, wasmCompat, model1, model2] = await Promise.all([
    assertAsset(urls.processor, 'DTLN worklet'),
    assertAsset(urls.wasmInternal, 'LiteRT wasm (relaxed)'),
    assertAsset(urls.wasmCompat, 'LiteRT wasm (compat)'),
    assertAsset(urls.model1, 'DTLN model 1'),
    assertAsset(urls.model2, 'DTLN model 2'),
  ]);

  return {
    urls,
    sizes: {
      processor: processor.byteLength,
      wasmInternal: wasmInternal.byteLength,
      wasmCompat: wasmCompat.byteLength,
      model1: model1.byteLength,
      model2: model2.byteLength,
    },
  };
}

export async function loadLiteRtWasmBinary(assetBaseUrl) {
  const variant = detectLiteRtVariant();
  const urls = dtlnAssetUrls(assetBaseUrl);
  const url = variant === 'compat' ? urls.wasmCompat : urls.wasmInternal;
  const binary = await assertAsset(url, `LiteRT wasm (${variant})`);
  return { variant, binary };
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
        reject(new Error(data.message || 'DTLN worklet reported an error'));
        return;
      }

      if (predicate(data)) {
        cleanup();
        resolve(data);
      }
    };

    const onProcessorError = () => {
      cleanup();
      reject(new Error('DTLN AudioWorklet processor failed'));
    };

    const cleanup = () => {
      clearTimeout(timer);
      node.port.removeEventListener('message', onMessage);
      node.removeEventListener('processorerror', onProcessorError);
    };

    node.port.addEventListener('message', onMessage);
    node.port.start();
    node.addEventListener('processorerror', onProcessorError);
  });
}

export async function createDtlnWorklet(context, { assetBaseUrl, bypassUntilReady = false } = {}) {
  const urls = dtlnAssetUrls(assetBaseUrl);
  const { variant, binary } = await loadLiteRtWasmBinary(assetBaseUrl);
  await context.audioWorklet.addModule(urls.processor);

  const node = new AudioWorkletNode(context, DTLN_PROCESSOR_NAME, {
    channelCount: 1,
    channelCountMode: 'explicit',
    numberOfInputs: 1,
    numberOfOutputs: 1,
    outputChannelCount: [1],
    processorOptions: {
      threads: false,
      numThreads: 1,
      bypassUntilReady,
      liteRtVariant: variant,
      liteRtWasmBinary: binary,
    },
  });

  const ready = waitForWorkletMessage(
    node,
    (data) => data?.type === 'ready',
    READY_TIMEOUT_MS,
    'Timed out waiting for DTLN / LiteRT to initialize',
  );

  return { node, ready, variant, processorName: DTLN_PROCESSOR_NAME };
}

export async function selfCheckDtln(assetBaseUrl) {
  const inventory = await verifyDtlnAssets(assetBaseUrl);
  console.info(`${LOG_PREFIX} assets present`, inventory.sizes);

  const context = new OfflineAudioContext({
    numberOfChannels: 1,
    length: DTLN_SAMPLE_RATE,
    sampleRate: DTLN_SAMPLE_RATE,
  });

  const { node, ready, variant } = await createDtlnWorklet(context, {
    assetBaseUrl,
    bypassUntilReady: false,
  });

  const processingStarted = waitForWorkletMessage(
    node,
    (data) => data?.type === 'processing-started',
    SELF_CHECK_TIMEOUT_MS,
    'DTLN loaded but never processed a test frame',
  );

  const oscillator = context.createOscillator();
  oscillator.type = 'sine';
  oscillator.frequency.value = 440;
  oscillator.connect(node);
  node.connect(context.destination);
  oscillator.start(0);

  await ready;
  console.info(`${LOG_PREFIX} DTLN runtime ready (${variant})`);

  await Promise.all([processingStarted, context.startRendering()]);
  node.port.postMessage({ type: 'dispose' });
  node.disconnect();

  console.info(`${LOG_PREFIX} self-check passed: model processed a test frame`);
  return { variant, assets: inventory.sizes };
}

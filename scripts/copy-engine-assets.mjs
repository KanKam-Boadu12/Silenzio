import { copyFile, mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const dest = join(root, 'public', 'engine');
const dfnPkg = join(root, 'node_modules', 'deepfilternet3-noise-filter', 'dist', 'index.esm.js');
const rnnoiseWasm = join(root, 'node_modules', '@jitsi', 'rnnoise-wasm', 'dist', 'rnnoise.wasm');

const CDN = 'https://cdn.mezon.ai/AI/models/datas/noise_suppression/deepfilternet3';
const REMOTE_ASSETS = [
  ['v3/pkg/df_bg.wasm', 'df_bg.wasm'],
  ['v3/models/DeepFilterNet3_onnx.tar.gz', 'DeepFilterNet3_onnx.tar.gz'],
];

await mkdir(dest, { recursive: true });

const esm = await readFile(dfnPkg, 'utf8');
const match = esm.match(/var workletCode = ("(?:\\.|[^"\\])*")/);
if (!match) {
  throw new Error('Could not extract DeepFilterNet3 worklet from deepfilternet3-noise-filter');
}

let worklet = JSON.parse(match[1]);
worklet = worklet.replace(
  `if (typeof TextDecoder === 'undefined') {`,
  `if (!globalThis.crypto?.getRandomValues) {
        const cryptoRandom = (array) => {
            for (let i = 0; i < array.length; i += 1) {
                array[i] = Math.floor(Math.random() * 256);
            }
            return array;
        };
        globalThis.crypto = { getRandomValues: cryptoRandom };
    }
    if (typeof TextDecoder === 'undefined') {`,
);
worklet = worklet.replace(
  'this.isInitialized = true;\n                this.port.onmessage = (event) => {',
  `this.isInitialized = true;
                this.port.postMessage({ type: 'ready' });
                this.port.onmessage = (event) => {`,
);
worklet = worklet.replace(
  'const processed = df_process_frame(this.dfModel.handle, this.tempFrame);',
  `const processed = df_process_frame(this.dfModel.handle, this.tempFrame);
                if (!this.processingStartedReported) {
                    this.processingStartedReported = true;
                    this.port.postMessage({ type: 'processing-started', processedQuanta: 1 });
                }`,
);
worklet = worklet.replace(
  `const outputAvailable = this.getOutputAvailable();
            if (outputAvailable >= 128) {`,
  `const outputAvailable = this.getOutputAvailable();
            if (outputAvailable < 128) {
                for (let inputNum = 0; inputNum < sourceLimit; inputNum++) {
                    const output = outputList[inputNum];
                    for (let channelNum = 0; channelNum < output.length; channelNum++) {
                        output[channelNum].fill(0);
                    }
                }
            } else if (outputAvailable >= 128) {`,
);
worklet = worklet.replace(
  `console.error('Failed to initialize DeepFilter in AudioWorklet:', error);`,
  `console.error('Failed to initialize DeepFilter in AudioWorklet:', error);
                this.port.postMessage({ type: 'error', message: String(error && error.message || error) });`,
);

await writeFile(join(dest, 'dfn-processor.js'), worklet);
console.log('extracted dfn-processor.js');

await copyFile(rnnoiseWasm, join(dest, 'rnnoise.wasm'));
console.log('copied rnnoise.wasm');

for (const [remote, local] of REMOTE_ASSETS) {
  const target = join(dest, local);
  try {
    const existing = await stat(target);
    if (existing.size > 1024 * 1024) {
      console.log(`kept ${local} (${existing.size} bytes)`);
      continue;
    }
  } catch {
    // Download a fresh copy
  }

  const url = `${CDN}/${remote}`;
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to download ${local} (${response.status}): ${url}`);
  }
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.byteLength < 1024) {
    throw new Error(`${local} is empty or truncated (${bytes.byteLength} bytes)`);
  }
  await writeFile(target, bytes);
  console.log(`downloaded ${local} (${bytes.byteLength} bytes)`);
}

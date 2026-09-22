import { copyFile, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const pkg = join(root, 'node_modules', '@workadventure', 'noise-suppression', 'dist');
const dest = join(root, 'public', 'dtln');

const files = [
  ['assets/audio-worklet-processor.js', 'dtln-processor.js'],
  ['assets/model_quant_1.tflite', 'model_quant_1.tflite'],
  ['assets/model_quant_2.tflite', 'model_quant_2.tflite'],
  ['vendor/litert/litert_wasm_internal.wasm', 'litert_wasm_internal.wasm'],
  ['vendor/litert/litert_wasm_compat_internal.wasm', 'litert_wasm_compat_internal.wasm'],
];

await mkdir(dest, { recursive: true });

for (const [from, to] of files) {
  const source = join(pkg, from);
  const target = join(dest, to);
  await copyFile(source, target);
  console.log(`copied ${to}`);
}

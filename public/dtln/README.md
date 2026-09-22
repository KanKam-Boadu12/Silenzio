# DTLN runtime assets

These files are copied from `@workadventure/noise-suppression` by
`scripts/copy-dtln-assets.mjs` before every build:

- `dtln-processor.js` — AudioWorklet bundle (LiteRT glue + both DTLN models)
- `litert_wasm_internal.wasm` / `litert_wasm_compat_internal.wasm` — LiteRT runtimes
- `model_quant_1.tflite` / `model_quant_2.tflite` — DTLN models (also inlined in the worklet)

The extension **fails loudly** if any of these are missing from the packed `dist/` folder.
Do not commit the binaries; they are produced at build time.

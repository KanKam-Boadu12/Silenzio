# Agent Noise Cancellation (End-to-End Bidirectional)

Chrome / Edge MV3 browser extension that provides **real-time end-to-end noise cancellation** on in-call web pages (e.g., Google Meet, MS Teams, Zoom Web, Twilio WebRTC):
1. **Outgoing Microphone (TX)**: Denoises the agent's microphone before WebRTC Opus encoding.
2. **Incoming Call Audio (RX)**: Intercepts remote caller audio streams, denoises them with DTLN, and delivers clean audio to the agent's speakers/headphones.

The denoiser is **DTLN** (Dual-signal Transformation LSTM Network) running in an `AudioWorklet` via LiteRT.js, using the packaged runtime from [`@workadventure/noise-suppression`](https://www.npmjs.com/package/@workadventure/noise-suppression).

## Why not RNNoise

An earlier scaffold used RNNoise but never shipped `rnnoise.wasm`, and the worklet **silently bypassed** to raw audio. This project does not do that.

If the DTLN models or LiteRT runtime are missing, fail to load, or never process a test frame:

- the popup shows **Noise cancellation: inactive** (red)
- a prominent warning explains that the call will hear/play raw audio
- the service worker / page console logs an unambiguous error
- the toolbar icon displays `ERR`
- the UI never reports **active** in bypass / fallback

## Audio contract

| | DTLN (this project) |
|---|---|
| Sample rate | **16 kHz** |
| Channels | 1 (Mono) |
| Frame size | **512 samples** (32 ms) |
| Worklet quantum | 128 samples (buffered ×4) |

- **TX**: `getUserMedia` requests `echoCancellation`, `noiseSuppression`, and `autoGainControl` all **false** so the browser suppressor is not stacked with DTLN. Noise suppression sits **before** the Opus encoder (`RTCPeerConnection` `addTrack` / `replaceTrack`).
- **RX**: Incoming streams attached to `HTMLMediaElement.prototype.srcObject` (<audio> / <video>) are intercepted, routed through the RX DTLN pipeline, and rendered clean to the output device.

## Dual Controls & Live A/B Testing

- **Master Switch**: Enable All / Disable All with one click.
- **Granular Toggles**: Independent `Denoise Mic` (TX) and `Denoise Call` (RX) controls.
- **Seamless A/B Comparison**: Toggling either direction off automatically restores the original raw stream without muting audio or interrupting the call.

## Develop

```bash
npm install
npm run build
```

`npm run copy-dtln` (also run by `build`) copies from `node_modules/@workadventure/noise-suppression`:

- `public/dtln/dtln-processor.js` (worklet + inlined models)
- `public/dtln/model_quant_1.tflite`
- `public/dtln/model_quant_2.tflite`
- `public/dtln/litert_wasm_internal.wasm`
- `public/dtln/litert_wasm_compat_internal.wasm`

Load **unpacked** `dist/` in `chrome://extensions` or `edge://extensions`. Enable on the call tab **before** joining (or refresh after enabling) so `getUserMedia`, `RTCPeerConnection`, and `HTMLMediaElement.srcObject` patches apply.

## License

Application code is part of this repo. The DTLN worklet, TFLite models, and LiteRT Wasm bytes are redistributed from `@workadventure/noise-suppression` (MIT).

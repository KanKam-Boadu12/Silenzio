# AGENT.md — Agent Noise Cancellation Extension (End-to-End Bidirectional)

## 1. Project Overview

**Agent Noise Cancellation** is a Chromium / Edge Manifest V3 (MV3) browser extension built to provide **real-time end-to-end bidirectional noise cancellation** on in-call web pages (e.g., Google Meet, Teams, Twilio WebRTC, call center tools):

- **Outgoing Audio (TX — Agent side)**: Denoises the agent's microphone before it reaches the WebRTC Opus encoder (`RTCPeerConnection.prototype.addTrack` / `replaceTrack`).
- **Incoming Audio (RX — Caller side)**: Intercepts remote caller audio streams via `HTMLMediaElement.prototype.srcObject` and Web Audio, denoises them with DTLN, and delivers clean audio to the agent's speakers/headphones.
- **Denoising engine**: DTLN (Dual-signal Transformation LSTM Network) using LiteRT.js (WebAssembly) inside an `AudioWorklet`, sourced from [`@workadventure/noise-suppression`](https://www.npmjs.com/package/@workadventure/noise-suppression).

---

## 2. Audio Contract & Invariants

| Specification | Value | Notes |
|---|---|---|
| **Sample Rate** | `16000 Hz` (16 kHz) | Must NOT be 48 kHz. AudioContext sampleRate must be 16000. |
| **Channels** | `1` (Mono) | Only mono audio is processed by DTLN. Stereo is downmixed. |
| **Frame Size** | `512 samples` (32 ms) | DTLN model inference frame size. |
| **Hop Size / Quantum**| `128 samples` (8 ms) | Web Audio standard quantum. 4 quanta buffer into 1 frame. |
| **Models** | `model_quant_1.tflite` + `model_quant_2.tflite` | Stage 1: Spectrogram mask. Stage 2: Waveform refinement. |
| **Runtime** | LiteRT.js Wasm | Auto-detects `relaxed` (SIMD) vs `compat` fallback. |

---

## 3. Critical Rule: Fail Loudly, Never Silently Bypass

- **Startup Self-Check**: When enabled, the extension runs [`selfCheckDtln()`](file:///Users/fido-akwesi/Desktop/Projects/noise-cancel-extension/src/audio/dtln-loader.js) on an `OfflineAudioContext` with a 440 Hz test tone before reporting `active`.
- **Never claim active in bypass**: If any model or Wasm asset is missing, fails to compile, or times out, the extension immediately transitions to `status: 'inactive'`.
- **Visual Alerting**:
  - Popup UI displays red badge: **`Noise cancellation: inactive`**
  - Prominent red alert banner explains: *"Noise cancellation is inactive. The call is using raw audio. [Failure reason]"*
  - Toolbar action icon displays **`ERR`** (red badge) so the agent notices even if the popup is closed.
  - Toolbar icon displays **`E2E`** when both TX and RX are actively processing, **`TX`** or **`RX`** when only one is active, and **`ARM`** when armed and waiting for audio.
  - Page console and service worker log explicit errors.
- **Live A/B Testing**: When the agent toggles **Disable All** or unchecks **Denoise Mic** / **Denoise Call**, the extension automatically swaps the original raw tracks/streams back into WebRTC senders and media elements without muting or interrupting the call.

---

## 4. Project Structure

```text
noise-cancel-extension/
├── public/
│   ├── manifest.json              # MV3 configuration, CSP, web_accessible_resources
│   └── dtln/                      # Runtime assets copied at build time
│       ├── dtln-processor.js      # Bundled AudioWorklet processor
│       ├── litert_wasm_internal.wasm
│       ├── litert_wasm_compat_internal.wasm
│       ├── model_quant_1.tflite
│       └── model_quant_2.tflite
├── src/
│   ├── audio/
│   │   ├── dtln-processor.js      # Constants & Float32RingBuffer contract
│   │   ├── dtln-loader.js         # Asset verification, SIMD probe & self-check
│   │   └── audio-pipeline.js      # AudioPipeline (handles TX and RX streams)
│   ├── popup/
│   │   ├── popup.js               # Popup controller
│   │   └── popup.css              # Popup styles (BEM)
│   ├── shared/
│   │   └── constants.js           # App name, storage key, message types
│   ├── background/
│   │   └── service-worker.js      # Session state & toolbar badge updates
│   └── content/
│       ├── content-script.js      # Isolated-world bridge injection & messaging
│       └── page-bridge.js         # getUserMedia, WebRTC & HTMLMediaElement interceptor
├── scripts/
│   └── copy-dtln-assets.mjs       # Copies DTLN models/wasm from node_modules
├── popup.html                     # Extension popup entry point
├── package.json
├── vite.config.js                 # Multi-entry Vite bundler config
└── eslint.config.js               # Flat ESLint configuration
```

---

## 5. Development & Build Commands

```bash
npm install
npm run copy-dtln
npm run build
npm run dev
npm run lint
npm run format
```

---

## 6. CSP & Chrome MV3 Permissions

- **Manifest CSP**: `script-src 'self' 'wasm-unsafe-eval'; object-src 'self';`
- **Web Accessible Resources**: `dtln/*` and `page-bridge.js`

-```2+2=4```

-```2+2=4```

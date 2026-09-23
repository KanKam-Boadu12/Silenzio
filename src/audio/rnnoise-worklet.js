import { createRNNWasmModuleSync } from '@jitsi/rnnoise-wasm';

const RNNOISE_SAMPLE_LENGTH = 480;
const PROC_QUANTUM = 128;
const SHIFT_16 = 32768;

function gcd(a, b) {
  return b === 0 ? a : gcd(b, a % b);
}

function lcm(a, b) {
  return (a * b) / gcd(a, b);
}

class NoiseSuppressorWorklet extends AudioWorkletProcessor {
  constructor() {
    super();
    this._wasm = createRNNWasmModuleSync();
    this._pcmInput = this._wasm._malloc(RNNOISE_SAMPLE_LENGTH * 4);
    this._pcmIndex = this._pcmInput >> 2;
    this._context = this._wasm._rnnoise_create();
    this._denoiseSampleSize = RNNOISE_SAMPLE_LENGTH;
    this._circularBufferLength = lcm(PROC_QUANTUM, this._denoiseSampleSize);
    this._circularBuffer = new Float32Array(this._circularBufferLength);
    this._inputBufferLength = 0;
    this._denoisedBufferLength = 0;
    this._denoisedBufferIndx = 0;
    this._processingStartedReported = false;
    this.port.postMessage({ type: 'ready' });
    this.port.onmessage = (event) => {
      if (event.data?.type === 'dispose') {
        try {
          this._wasm._rnnoise_destroy(this._context);
          this._wasm._free(this._pcmInput);
        } catch {
          // Ignore dispose errors
        }
      }
    };
  }

  process(inputs, outputs) {
    const inData = inputs[0]?.[0];
    const outData = outputs[0]?.[0];
    if (!inData || !outData) {
      return true;
    }

    this._circularBuffer.set(inData, this._inputBufferLength);
    this._inputBufferLength += inData.length;

    for (
      ;
      this._denoisedBufferLength + this._denoiseSampleSize <= this._inputBufferLength;
      this._denoisedBufferLength += this._denoiseSampleSize
    ) {
      const frame = this._circularBuffer.subarray(
        this._denoisedBufferLength,
        this._denoisedBufferLength + this._denoiseSampleSize,
      );
      for (let i = 0; i < RNNOISE_SAMPLE_LENGTH; i += 1) {
        this._wasm.HEAPF32[this._pcmIndex + i] = frame[i] * SHIFT_16;
      }
      this._wasm._rnnoise_process_frame(this._context, this._pcmInput, this._pcmInput);
      for (let i = 0; i < RNNOISE_SAMPLE_LENGTH; i += 1) {
        frame[i] = this._wasm.HEAPF32[this._pcmIndex + i] / SHIFT_16;
      }
      if (!this._processingStartedReported) {
        this._processingStartedReported = true;
        this.port.postMessage({ type: 'processing-started', processedQuanta: 1 });
      }
    }

    const unsent =
      this._denoisedBufferIndx > this._denoisedBufferLength
        ? this._circularBufferLength - this._denoisedBufferIndx
        : this._denoisedBufferLength - this._denoisedBufferIndx;

    if (unsent >= outData.length) {
      outData.set(
        this._circularBuffer.subarray(this._denoisedBufferIndx, this._denoisedBufferIndx + outData.length),
      );
      this._denoisedBufferIndx += outData.length;
    }

    if (this._denoisedBufferIndx === this._circularBufferLength) {
      this._denoisedBufferIndx = 0;
    }
    if (this._inputBufferLength === this._circularBufferLength) {
      this._inputBufferLength = 0;
      this._denoisedBufferLength = 0;
    }

    return true;
  }
}

registerProcessor('NoiseSuppressorWorklet', NoiseSuppressorWorklet);

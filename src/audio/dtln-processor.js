/**
 * DTLN worklet contract.
 *
 * Sample rate: 16 kHz (not RNNoise's 48 kHz).
 * Frame size: 512 samples (32 ms). AudioWorklet quanta are typically 128 samples,
 * so the production processor buffers four quanta, runs DTLN, then drains 128
 * samples at a time.
 *
 * The production AudioWorklet (LiteRT.js + both DTLN TFLite models inlined) is
 * copied from @workadventure/noise-suppression into public/dtln/dtln-processor.js
 * at build time. That file registers `workadventure-noise-suppression`.
 */
export const DTLN_PROCESSOR_NAME = 'workadventure-noise-suppression';
export const DTLN_SAMPLE_RATE = 16000;
export const DTLN_FRAME_SIZE = 512;
export const DTLN_FRAME_DURATION_MS = 32;
export const DTLN_QUANTUM_SIZE = 128;

export class Float32RingBuffer {
  constructor(capacity) {
    this.buffer = new Float32Array(capacity);
    this.readIndex = 0;
    this.writeIndex = 0;
    this.availableSamples = 0;
  }

  availableRead() {
    return this.availableSamples;
  }

  push(samples) {
    for (let i = 0; i < samples.length; i += 1) {
      this.buffer[this.writeIndex] = samples[i];
      this.writeIndex = (this.writeIndex + 1) % this.buffer.length;
      if (this.availableSamples < this.buffer.length) {
        this.availableSamples += 1;
      } else {
        this.readIndex = (this.readIndex + 1) % this.buffer.length;
      }
    }
  }

  pullInto(target) {
    if (this.availableSamples < target.length) {
      return false;
    }

    for (let i = 0; i < target.length; i += 1) {
      target[i] = this.buffer[this.readIndex];
      this.readIndex = (this.readIndex + 1) % this.buffer.length;
      this.availableSamples -= 1;
    }

    return true;
  }

  clear() {
    this.readIndex = 0;
    this.writeIndex = 0;
    this.availableSamples = 0;
  }
}

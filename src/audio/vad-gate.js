export const VAD_OPEN_THRESHOLD = 0.4;
export const GATE_FLOOR = 0.02;
export const GATE_HOLD_FRAMES = 20;
export const GATE_ATTACK_SAMPLES = 96;
export const GATE_RELEASE_SAMPLES = 1920;

/**
 * Silences whatever RNNoise leaves behind between words. RNNoise reports a
 * voice probability for every 10 ms frame; while that stays low (after a short
 * hold so word endings are not clipped) the gain glides down to a near-silent
 * floor, and it snaps back open quickly when speech returns.
 */
export class VadGate {
  constructor({
    openThreshold = VAD_OPEN_THRESHOLD,
    floor = GATE_FLOOR,
    holdFrames = GATE_HOLD_FRAMES,
    attackSamples = GATE_ATTACK_SAMPLES,
    releaseSamples = GATE_RELEASE_SAMPLES,
  } = {}) {
    this.openThreshold = openThreshold;
    this.floor = floor;
    this.holdFrames = holdFrames;
    this.attackStep = (1 - floor) / attackSamples;
    this.releaseStep = (1 - floor) / releaseSamples;
    this.gain = floor;
    this.hold = 0;
  }

  apply(frame, voiceProbability) {
    if (voiceProbability >= this.openThreshold) {
      this.hold = this.holdFrames;
    } else if (this.hold > 0) {
      this.hold -= 1;
    }

    const target = this.hold > 0 ? 1 : this.floor;
    for (let i = 0; i < frame.length; i += 1) {
      if (this.gain < target) {
        this.gain = Math.min(target, this.gain + this.attackStep);
      } else if (this.gain > target) {
        this.gain = Math.max(target, this.gain - this.releaseStep);
      }
      frame[i] *= this.gain;
    }
  }
}

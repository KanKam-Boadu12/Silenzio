import assert from 'node:assert/strict';
import test from 'node:test';
import { GATE_FLOOR, VadGate } from './vad-gate.js';

function frameOf(value) {
  return new Float32Array(480).fill(value);
}

test('VadGate starts closed so the first noise is quiet', () => {
  const gate = new VadGate();
  const frame = frameOf(0.5);
  gate.apply(frame, 0.02);
  assert.ok(Math.abs(frame[0] - 0.5 * GATE_FLOOR) < 1e-6);
});

test('VadGate passes speech at full level', () => {
  const gate = new VadGate();
  const frame = frameOf(0.5);
  gate.apply(frame, 0.95);
  assert.equal(frame[479], 0.5);
});

test('VadGate keeps the gate open during the hold window after speech', () => {
  const gate = new VadGate({ holdFrames: 5 });
  gate.apply(frameOf(0.5), 0.95);
  const frame = frameOf(0.5);
  gate.apply(frame, 0.05);
  assert.equal(frame[479], 0.5);
});

test('VadGate attenuates residual noise once speech has stopped', () => {
  const gate = new VadGate({ holdFrames: 2 });
  gate.apply(frameOf(0.5), 0.95);
  let frame;
  for (let i = 0; i < 20; i += 1) {
    frame = frameOf(0.5);
    gate.apply(frame, 0.02);
  }
  assert.ok(Math.abs(frame[479] - 0.5 * GATE_FLOOR) < 1e-6);
});

test('VadGate reopens quickly when speech returns', () => {
  const gate = new VadGate({ holdFrames: 1 });
  for (let i = 0; i < 20; i += 1) {
    gate.apply(frameOf(0.5), 0.02);
  }
  const frame = frameOf(0.5);
  gate.apply(frame, 0.95);
  assert.ok(frame[479] > 0.45);
});

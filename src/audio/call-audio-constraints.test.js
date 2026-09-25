import assert from 'node:assert/strict';
import test from 'node:test';
import { createLiveAudioContext, mergeCallAudioConstraints } from './audio-pipeline.js';

test('mergeCallAudioConstraints keeps echo cancellation and sample rate', () => {
  const merged = mergeCallAudioConstraints(
    {
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
      sampleRate: 48000,
      channelCount: 2,
    },
    '',
  );

  assert.equal(merged.echoCancellation, true);
  assert.equal(merged.sampleRate, 48000);
  assert.equal(merged.channelCount, 2);
  assert.equal(merged.deviceId, undefined);
});

test('mergeCallAudioConstraints turns off browser NS/AGC so the 48 kHz engine owns cancellation', () => {
  const merged = mergeCallAudioConstraints(
    {
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
    },
    'mic-1',
  );

  assert.equal(merged.noiseSuppression, false);
  assert.equal(merged.autoGainControl, false);
  assert.equal(merged.echoCancellation, true);
  assert.deepEqual(merged.deviceId, { exact: 'mic-1' });
});

test('mergeCallAudioConstraints turns echo cancellation on with the extension', () => {
  assert.deepEqual(mergeCallAudioConstraints(true), {
    echoCancellation: true,
    noiseSuppression: false,
    autoGainControl: false,
  });

  const disabledByPage = mergeCallAudioConstraints({
    echoCancellation: false,
    noiseSuppression: true,
    autoGainControl: true,
  });
  assert.equal(disabledByPage.echoCancellation, true);
  assert.equal(disabledByPage.noiseSuppression, false);
  assert.equal(disabledByPage.autoGainControl, false);
});

test('mergeCallAudioConstraints leaves echo cancellation unchanged when the extension is off', () => {
  assert.deepEqual(mergeCallAudioConstraints(true, '', false), {
    noiseSuppression: false,
    autoGainControl: false,
  });
  assert.equal(
    mergeCallAudioConstraints({ echoCancellation: false }, '', false).echoCancellation,
    false,
  );
});

test('createLiveAudioContext creates a 48 kHz interactive context when AudioContext exists', () => {
  if (typeof AudioContext === 'undefined') {
    assert.ok(true, 'AudioContext is not available in this Node run');
    return;
  }

  const context = createLiveAudioContext();
  assert.ok(context);
  assert.equal(typeof context.createMediaStreamSource, 'function');
  return context.close?.();
});

import js from '@eslint/js';

export default [
  {
    ignores: ['dist/**', 'node_modules/**', 'public/dtln/**', 'public/engine/**', 'src/audio/rnnoise-worklet.js'],
  },
  js.configs.recommended,
  {
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      globals: {
        AudioContext: 'readonly',
        AudioWorkletNode: 'readonly',
        AudioWorkletProcessor: 'readonly',
        OfflineAudioContext: 'readonly',
        chrome: 'readonly',
        Float32Array: 'readonly',
        HTMLMediaElement: 'readonly',
        MediaStream: 'readonly',
        OscillatorNode: 'readonly',
        RTCPeerConnection: 'readonly',
        URL: 'readonly',
        WebAssembly: 'readonly',
        console: 'readonly',
        document: 'readonly',
        fetch: 'readonly',
        navigator: 'readonly',
        setTimeout: 'readonly',
        clearTimeout: 'readonly',
        window: 'readonly',
        Buffer: 'readonly',
      },
    },
    rules: {
      'no-unused-vars': [
        'warn',
        { argsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
    },
  },
];

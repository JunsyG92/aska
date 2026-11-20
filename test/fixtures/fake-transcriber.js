#!/usr/bin/env node
// Fake speech-to-text CLI for tests: called like whisper.cpp ("-f <file.wav>"),
// it checks the recording it is given and prints what a transcriber would.
const fs = require('fs');
const args = process.argv.slice(2);
const file = args[args.indexOf('-f') + 1];
let wav = null;
try {
  wav = fs.readFileSync(file);
} catch { /* reported below */ }
if (process.env.FAKE_STT_LOG) {
  const entry = {
    args,
    file,
    riff: !!wav && wav.toString('latin1', 0, 4) === 'RIFF' && wav.toString('latin1', 8, 12) === 'WAVE',
    rate: wav ? wav.readUInt32LE(24) : 0,
    seconds: wav ? (wav.length - 44) / 32000 : 0,
    env: Object.keys(process.env),
  };
  fs.appendFileSync(process.env.FAKE_STT_LOG, JSON.stringify(entry) + '\n');
}
if (!wav) {
  process.stderr.write('error: failed to read the audio file\n');
  process.exit(2);
}
process.stdout.write('\n[00:00:00.000 --> 00:00:01.400]   When do we launch?\n[00:00:01.400 --> 00:00:01.600]   [BLANK_AUDIO]\n');

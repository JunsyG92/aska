'use strict';
// Listening: records the microphone and cuts it into utterances (speech between
// two silences), handed one by one to the main process, which transcribes them.
// The cutting is pure logic, shared with the unit tests; the recording itself
// needs the window.

(function (root) {
  const SAMPLE_RATE = 16000;

  /**
   * Cuts a stream of samples into utterances, from their loudness. Speech starts
   * when a few frames in a row are clearly above the ambient noise, and ends
   * after a silence; a long monologue is cut so that it is transcribed as it goes.
   *   push(Float32Array) -> [Float32Array] (the utterances that just ended)
   *   flush() -> the utterance in progress, if any
   *   level: loudness of the last frame, 0 to 1
   */
  function createSegmenter({
    sampleRate = SAMPLE_RATE,
    frameMs = 30,
    startFrames = 3,
    endSilenceMs = 800,
    maxMs = 25000,
    minSpeechMs = 300,
    preRollMs = 300,
    floor = 0.008,
    ratio = 3,
  } = {}) {
    const frame = Math.round((sampleRate * frameMs) / 1000);
    const endFrames = Math.ceil(endSilenceMs / frameMs);
    const maxFrames = Math.floor(maxMs / frameMs);
    const minFrames = Math.ceil(minSpeechMs / frameMs);
    const preFrames = Math.ceil(preRollMs / frameMs);
    let pending = new Float32Array(0);
    let pre = []; // last frames before speech: the start of a word is not cut off
    let cur = null; // frames of the utterance in progress
    let loud = 0; // loud frames in the utterance
    let run = 0; // loud frames in a row, before speech starts
    let quiet = 0; // quiet frames in a row, during speech
    let noise = floor / 2; // ambient noise, followed slowly
    const seg = { level: 0, speaking: false };

    const join = (frames) => {
      const out = new Float32Array(frames.length * frame);
      frames.forEach((f, i) => out.set(f, i * frame));
      return out;
    };
    const close = (out) => {
      // A click or a cough is not an utterance.
      if (cur && loud >= minFrames) out.push(join(cur));
      cur = null;
      loud = 0;
      quiet = 0;
      run = 0;
      seg.speaking = false;
    };

    function onFrame(f, out) {
      let sum = 0;
      for (let i = 0; i < f.length; i++) sum += f[i] * f[i];
      const rms = Math.sqrt(sum / f.length);
      seg.level = Math.min(1, rms * 6);
      const isLoud = rms > Math.max(floor, noise * ratio);
      if (!cur) {
        if (!isLoud) noise = noise * 0.95 + rms * 0.05;
        run = isLoud ? run + 1 : 0;
        pre.push(f);
        if (pre.length > preFrames + startFrames) pre.shift();
        if (run >= startFrames) {
          cur = pre;
          pre = [];
          loud = run;
          quiet = 0;
          seg.speaking = true;
        }
        return;
      }
      cur.push(f);
      if (isLoud) {
        loud += 1;
        quiet = 0;
      } else quiet += 1;
      if (quiet >= endFrames || cur.length >= maxFrames) close(out);
    }

    seg.push = (samples) => {
      const out = [];
      const all = new Float32Array(pending.length + samples.length);
      all.set(pending);
      all.set(samples, pending.length);
      let i = 0;
      for (; i + frame <= all.length; i += frame) onFrame(all.slice(i, i + frame), out);
      pending = all.slice(i);
      return out;
    };
    seg.flush = () => {
      const out = [];
      close(out);
      pending = new Float32Array(0);
      pre = [];
      return out[0] || null;
    };
    return seg;
  }

  /** Samples as 16-bit integers, little-endian: what the main process writes to the WAV file. */
  function toPcm16(samples) {
    const out = new Uint8Array(samples.length * 2);
    const view = new DataView(out.buffer);
    for (let i = 0; i < samples.length; i++) {
      const s = Math.max(-1, Math.min(1, samples[i]));
      view.setInt16(i * 2, Math.round(s < 0 ? s * 32768 : s * 32767), true);
    }
    return out;
  }

  /**
   * Starts recording. onSegment(Uint8Array) gets each utterance, onLevel(0..1, speaking)
   * the loudness a few times per second. Returns { stop() }.
   * Throws what getUserMedia throws (NotAllowedError, NotFoundError…).
   */
  async function start({ onSegment, onLevel }) {
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      video: false,
    });
    let ctx;
    try {
      ctx = new AudioContext({ sampleRate: SAMPLE_RATE });
      await ctx.audioWorklet.addModule('listen-worklet.js');
    } catch (e) {
      stream.getTracks().forEach((tr) => tr.stop());
      if (ctx) ctx.close().catch(() => {});
      throw e;
    }
    const segmenter = createSegmenter({ sampleRate: ctx.sampleRate });
    const source = ctx.createMediaStreamSource(stream);
    const capture = new AudioWorkletNode(ctx, 'aska-capture', { numberOfInputs: 1, numberOfOutputs: 1, channelCount: 1 });
    // The graph only runs when it reaches the output: through a muted gain, so nothing is played back.
    const mute = ctx.createGain();
    mute.gain.value = 0;
    source.connect(capture).connect(mute).connect(ctx.destination);
    let lastLevel = 0;
    capture.port.onmessage = (e) => {
      for (const s of segmenter.push(e.data)) onSegment(toPcm16(s));
      const now = Date.now();
      if (onLevel && now - lastLevel > 90) {
        lastLevel = now;
        onLevel(segmenter.level, segmenter.speaking);
      }
    };
    return {
      stop() {
        capture.port.onmessage = null;
        stream.getTracks().forEach((tr) => tr.stop());
        ctx.close().catch(() => {});
        // What was being said when listening stopped is still transcribed.
        const last = segmenter.flush();
        if (last) onSegment(toPcm16(last));
      },
    };
  }

  const api = { SAMPLE_RATE, createSegmenter, toPcm16, start };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.AskaListen = api;
})(typeof window === 'object' ? window : globalThis);

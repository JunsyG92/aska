'use strict';
// Audio thread: hands the microphone samples to the window, in blocks.
// No processing here: the cutting into utterances is done in listen.js.

class AskaCapture extends AudioWorkletProcessor {
  constructor() {
    super();
    this.block = new Float32Array(2048);
    this.fill = 0;
  }

  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (!ch) return true;
    for (let i = 0; i < ch.length; i++) {
      this.block[this.fill++] = ch[i];
      if (this.fill === this.block.length) {
        this.port.postMessage(this.block.slice(0));
        this.fill = 0;
      }
    }
    return true;
  }
}

registerProcessor('aska-capture', AskaCapture);

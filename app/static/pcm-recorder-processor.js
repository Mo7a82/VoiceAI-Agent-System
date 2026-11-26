// Captures mic audio, converts float samples to 16-bit PCM and posts
// ~40 ms chunks to the main thread. The AudioContext runs at 16 kHz,
// so no resampling is needed here.
class PcmRecorderProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.chunkSize = 640; // 40 ms at 16 kHz
    this.buffer = new Int16Array(this.chunkSize);
    this.offset = 0;
  }

  process(inputs) {
    const input = inputs[0] && inputs[0][0];
    if (!input) return true;
    for (let i = 0; i < input.length; i++) {
      const s = Math.max(-1, Math.min(1, input[i]));
      this.buffer[this.offset++] = s < 0 ? s * 0x8000 : s * 0x7fff;
      if (this.offset === this.chunkSize) {
        this.port.postMessage(this.buffer.buffer, [this.buffer.buffer]);
        this.buffer = new Int16Array(this.chunkSize);
        this.offset = 0;
      }
    }
    return true;
  }
}

registerProcessor("pcm-recorder-processor", PcmRecorderProcessor);

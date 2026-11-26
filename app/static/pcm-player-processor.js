// Plays 16-bit PCM at 24 kHz from a ring buffer. Posting {command:"clear"}
// drops everything queued, which is how barge-in stops the agent instantly.
class PcmPlayerProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.size = 24000 * 180; // 3 minutes of headroom
    this.ring = new Float32Array(this.size);
    this.write = 0;
    this.read = 0;
    this.port.onmessage = (e) => {
      if (e.data && e.data.command === "clear") {
        this.read = this.write;
        return;
      }
      const samples = new Int16Array(e.data);
      for (let i = 0; i < samples.length; i++) {
        this.ring[this.write] = samples[i] / 32768;
        this.write = (this.write + 1) % this.size;
        if (this.write === this.read) this.read = (this.read + 1) % this.size;
      }
    };
  }

  process(_inputs, outputs) {
    const out = outputs[0][0];
    for (let i = 0; i < out.length; i++) {
      if (this.read === this.write) {
        out[i] = 0;
      } else {
        out[i] = this.ring[this.read];
        this.read = (this.read + 1) % this.size;
      }
    }
    for (let c = 1; c < outputs[0].length; c++) outputs[0][c].set(out);
    return true;
  }
}

registerProcessor("pcm-player-processor", PcmPlayerProcessor);

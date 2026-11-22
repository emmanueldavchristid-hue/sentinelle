// Capture du micro pour la conversation en direct : ramène le son à 16 kHz mono 16 bits et le remet par paquets de 50 ms.
// Rien n'est gardé ici : chaque paquet est transmis puis oublié.
class LiveCapture extends AudioWorkletProcessor {
  constructor() {
    super();
    this.ratio = sampleRate / 16000;
    this.pos = 0;
    this.acc = 0;
    this.n = 0;
    this.out = new Int16Array(800);
    this.len = 0;
    this.sumSq = 0;
  }
  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (!ch) return true;
    for (let i = 0; i < ch.length; i++) {
      this.acc += ch[i];
      this.n++;
      this.pos += 1;
      if (this.pos >= this.ratio) {
        this.pos -= this.ratio;
        const v = Math.max(-1, Math.min(1, this.acc / this.n));
        this.acc = 0;
        this.n = 0;
        this.out[this.len++] = v * 0x7fff;
        this.sumSq += v * v;
        if (this.len === this.out.length) {
          const pcm = this.out.slice(0).buffer;
          this.port.postMessage({ pcm, level: Math.sqrt(this.sumSq / this.len) }, [pcm]);
          this.len = 0;
          this.sumSq = 0;
        }
      }
    }
    return true;
  }
}
registerProcessor('live-capture', LiveCapture);

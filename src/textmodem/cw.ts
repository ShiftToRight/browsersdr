import { cwTextSettings, type CwTextSettings } from "./settings";

// International Morse assignments (ITU-R M.1677-1). No language guessing.
const MORSE: Record<string, string> = Object.fromEntries([
  "A .-", "B -...", "C -.-.", "D -..", "E .", "F ..-.", "G --.", "H ....", "I ..", "J .---", "K -.-", "L .-..", "M --", "N -.", "O ---", "P .--.", "Q --.-", "R .-.", "S ...", "T -", "U ..-", "V ...-", "W .--", "X -..-", "Y -.--", "Z --..",
  "0 -----", "1 .----", "2 ..---", "3 ...--", "4 ....-", "5 .....", "6 -....", "7 --...", "8 ---..", "9 ----.", ". .-.-.-", ", --..--", "? ..--..", "/ -..-.", "= -...-", "+ .-.-.", "- -....-", "@ .--.-.", "' .----.", ": ---...", "( -.--.", ") -.--.-",
].map(entry => { const [text, code] = entry.split(" "); return [code!, text!]; }));

export class CwTextDemodulator {
  private i = 0;
  private q = 0;
  private envelope = 0;
  private peak = 0.01;
  private floor = 0.0001;
  private count = 0;
  private tick = 0;
  private keyed = false;
  private candidate = false;
  private candidateSince = 0;
  private changedAt = 0;
  private symbols = "";
  private wordPending = false;
  private unit: number;
  private settings: CwTextSettings;
  level = 0;
  confidence = 0;
  constructor(private rate: number, settings: CwTextSettings | undefined, private character: (text: string) => void, private error: () => void) {
    this.settings = cwTextSettings(settings);
    this.unit = 1.2 / this.settings.wpm;
  }
  get estimatedWpm(): number { return 1.2 / this.unit; }
  push(i: number, q: number): void {
    const a = 1 - Math.exp(-2 * Math.PI * 120 / this.rate);
    this.i += a * (i - this.i); this.q += a * (q - this.q);
    this.envelope += (1 - Math.exp(-1 / (0.003 * this.rate))) * (Math.hypot(this.i, this.q) - this.envelope);
    if (++this.count < this.rate / 1000) return;
    this.count -= this.rate / 1000;
    const time = ++this.tick / 1000;
    this.peak = Math.max(this.envelope, this.peak * 0.9997, 0.002);
    if (!this.keyed) this.floor += 0.001 * (Math.min(this.envelope, this.peak * 0.15) - this.floor);
    const threshold = Math.max(0.001, this.peak * this.settings.threshold, this.floor * 3);
    const desired = this.envelope > threshold * (this.keyed ? 0.65 : 1);
    if (desired !== this.candidate) { this.candidate = desired; this.candidateSince = time; }
    if (desired !== this.keyed && time - this.candidateSince >= 0.003) {
      const duration = this.candidateSince - this.changedAt;
      if (this.keyed) {
        if (duration >= this.unit * 0.3 && duration <= this.unit * 5) {
          const dash = duration > this.unit * 2;
          this.symbols += dash ? "-" : ".";
          if (this.settings.autoSpeed) this.unit = Math.max(1.2 / 60, Math.min(1.2 / 5, this.unit * 0.85 + duration / (dash ? 3 : 1) * 0.15));
          if (this.symbols.length > 8) { this.character("�"); this.error(); this.symbols = ""; }
        } else if (duration > this.unit * 5) { this.character("�"); this.error(); this.symbols = ""; }
      }
      this.keyed = desired; this.changedAt = this.candidateSince;
    }
    if (!this.keyed) {
      const gap = time - this.changedAt;
      if (gap >= this.unit * 2.5) this.emit();
      if (gap >= this.unit * 6 && this.wordPending) { this.character(" "); this.wordPending = false; }
    }
    this.level = this.envelope;
    this.confidence = Math.max(0, Math.min(1, 1 - this.floor * 3 / this.peak));
  }
  private emit(): void {
    if (!this.symbols) return;
    const text = MORSE[this.symbols];
    this.character(text ?? "�");
    if (!text) this.error();
    this.wordPending = true; this.symbols = "";
  }
  flush(): void { if (!this.keyed) this.emit(); }
}

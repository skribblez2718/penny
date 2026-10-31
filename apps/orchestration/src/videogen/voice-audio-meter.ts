/** Mono/stereo PCM16 integrated loudness, K-weighting and two-stage gating. These are
 * signal measurements, never speech/identity/intelligibility evidence. DeMan biquad equations:
 * https://github.com/csteinmetz1/pyloudnorm/blob/master/pyloudnorm/iirfilter.py
 * Gating follows ITU-R BS.1770's 400ms blocks, 100ms step, -70 LUFS absolute/-10 LU relative.
 * No decoder, native process, dependency, or implicit resampling is introduced. */
export function measureVoiceLoudness(
  data: Buffer,
  channels: 1 | 2,
  rate: number
): { peak_dbfs: number; loudness_lufs: number } {
  if (
    !Number.isSafeInteger(rate) ||
    rate < 8000 ||
    rate > 192000 ||
    data.length > 268435456 ||
    data.length % (2 * channels) !== 0
  )
    throw new Error("voice loudness PCM bounds");
  const samples = data.length / (2 * channels),
    block = Math.round(rate * 0.4),
    step = Math.round(rate * 0.1);
  if (samples < block)
    throw new Error("voice loudness requires a complete 400ms measurement block");
  const biquad = (shelf: boolean) => {
    const k = Math.tan((Math.PI * (shelf ? 1681.9744509555319 : 38.13547087613982)) / rate);
    const q = shelf ? 0.7071752369554193 : 0.5003270373253953;
    const denominator = 1 + k / q + k * k;
    const vh = 10 ** (3.99984385397 / 20),
      vb = vh ** 0.499666774155;
    const b0 = shelf ? (vh + (vb * k) / q + k * k) / denominator : 1;
    const b1 = shelf ? (2 * (k * k - vh)) / denominator : -2;
    const b2 = shelf ? (vh - (vb * k) / q + k * k) / denominator : 1;
    const a1 = (2 * (k * k - 1)) / denominator,
      a2 = (1 - k / q + k * k) / denominator;
    let x1 = 0,
      x2 = 0,
      y1 = 0,
      y2 = 0;
    return (x: number): number => {
      const y = b0 * x + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2;
      x2 = x1;
      x1 = x;
      y2 = y1;
      y1 = y;
      return y;
    };
  };
  const filters = Array.from({ length: channels }, () => ({
    shelf: biquad(true),
    pass: biquad(false),
  }));
  const ring = new Float64Array(block),
    powers: number[] = [];
  let power = 0,
    peak = 0;
  for (let i = 0; i < samples; i++) {
    let squared = 0;
    for (let ch = 0; ch < channels; ch++) {
      const raw = data.readInt16LE((i * channels + ch) * 2),
        f = filters[ch];
      if (!f) throw new Error("voice loudness channel state");
      peak = Math.max(peak, Math.abs(raw));
      const weighted = f.pass(f.shelf(raw / 32768));
      squared += weighted * weighted;
    }
    const index = i % block;
    power += squared - (ring[index] ?? 0);
    ring[index] = squared;
    if (i + 1 >= block && (i + 1 - block) % step === 0) powers.push(Math.max(0, power / block));
  }
  const lufs = (p: number): number => -0.691 + 10 * Math.log10(p);
  const absolute = powers.filter((p) => lufs(p) >= -70);
  if (peak === 0 || absolute.length === 0) throw new Error("silent or below-gate voice signal");
  const relative = lufs(absolute.reduce((a, b) => a + b, 0) / absolute.length) - 10;
  const gated = absolute.filter((p) => lufs(p) > relative);
  const loudness = lufs(gated.reduce((a, b) => a + b, 0) / gated.length);
  if (!Number.isFinite(loudness)) throw new Error("nonfinite voice loudness");
  return { peak_dbfs: 20 * Math.log10(peak / 32768), loudness_lufs: loudness };
}

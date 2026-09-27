//! Streaming mono resampler: windowed-sinc low-pass (when downsampling) followed
//! by linear interpolation. Good enough for speech → 16 kHz ASR input; not a
//! mastering-grade SRC. Pure and unit-tested.

/// Number of FIR taps for the anti-alias filter (odd → symmetric, integer delay).
const FIR_TAPS: usize = 31;

pub struct Resampler {
    in_rate: u32,
    out_rate: u32,
    /// Input samples advanced per output sample.
    step: f64,
    /// Fractional read position into `buf`.
    pos: f64,
    /// Anti-alias filter (None when not downsampling).
    fir: Option<Vec<f32>>,
    /// Last `FIR_TAPS - 1` raw input samples (filter state).
    hist: Vec<f32>,
    /// Filtered samples not yet fully consumed by the interpolator.
    buf: Vec<f32>,
}

impl Resampler {
    pub fn new(in_rate: u32, out_rate: u32) -> Self {
        let in_rate = in_rate.max(1);
        let out_rate = out_rate.max(1);
        let fir = if in_rate > out_rate {
            // Cutoff a little below the output Nyquist, normalised to the input rate.
            Some(lowpass_taps(0.45 * out_rate as f64 / in_rate as f64, FIR_TAPS))
        } else {
            None
        };
        Self {
            in_rate,
            out_rate,
            step: in_rate as f64 / out_rate as f64,
            pos: 0.0,
            hist: if fir.is_some() {
                vec![0.0; FIR_TAPS - 1]
            } else {
                Vec::new()
            },
            fir,
            buf: Vec::new(),
        }
    }

    pub fn in_rate(&self) -> u32 {
        self.in_rate
    }

    /// Resample `input` (mono, `in_rate`) and append the result (mono,
    /// `out_rate`) to `out`. State carries across calls, so chunked input yields
    /// the same stream as one big call.
    pub fn process(&mut self, input: &[f32], out: &mut Vec<f32>) {
        if self.in_rate == self.out_rate {
            out.extend_from_slice(input);
            return;
        }
        match &self.fir {
            Some(taps) => {
                // Convolve over [hist | input]; one output per input sample.
                let n = taps.len();
                let mut work = Vec::with_capacity(self.hist.len() + input.len());
                work.extend_from_slice(&self.hist);
                work.extend_from_slice(input);
                for i in 0..input.len() {
                    let window = &work[i..i + n];
                    let mut acc = 0.0f32;
                    for (s, t) in window.iter().zip(taps.iter()) {
                        acc += s * t;
                    }
                    self.buf.push(acc);
                }
                let keep = n - 1;
                self.hist.clear();
                self.hist.extend_from_slice(&work[work.len() - keep..]);
            }
            None => self.buf.extend_from_slice(input),
        }

        // Linear interpolation over the filtered buffer.
        while self.pos + 1.0 < self.buf.len() as f64 {
            let i = self.pos as usize;
            let frac = (self.pos - i as f64) as f32;
            out.push(self.buf[i] + (self.buf[i + 1] - self.buf[i]) * frac);
            self.pos += self.step;
        }
        let consumed = (self.pos as usize).min(self.buf.len());
        self.buf.drain(..consumed);
        self.pos -= consumed as f64;
    }
}

/// Windowed-sinc (Hamming) low-pass taps, unity DC gain. `cutoff` is normalised
/// to the sample rate (0..0.5).
fn lowpass_taps(cutoff: f64, taps: usize) -> Vec<f32> {
    let m = (taps - 1) as f64;
    let mut h: Vec<f64> = (0..taps)
        .map(|i| {
            let x = i as f64 - m / 2.0;
            let sinc = if x == 0.0 {
                2.0 * cutoff
            } else {
                (2.0 * std::f64::consts::PI * cutoff * x).sin() / (std::f64::consts::PI * x)
            };
            let w = 0.54 - 0.46 * (2.0 * std::f64::consts::PI * i as f64 / m).cos();
            sinc * w
        })
        .collect();
    let sum: f64 = h.iter().sum();
    for v in &mut h {
        *v /= sum;
    }
    h.into_iter().map(|v| v as f32).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sine(rate: u32, freq: f32, secs: f32) -> Vec<f32> {
        let n = (rate as f32 * secs) as usize;
        (0..n)
            .map(|i| (2.0 * std::f32::consts::PI * freq * i as f32 / rate as f32).sin() * 0.5)
            .collect()
    }

    fn rms(x: &[f32]) -> f32 {
        (x.iter().map(|v| v * v).sum::<f32>() / x.len() as f32).sqrt()
    }

    #[test]
    fn passthrough_same_rate() {
        let mut r = Resampler::new(16000, 16000);
        let input = sine(16000, 440.0, 0.1);
        let mut out = Vec::new();
        r.process(&input, &mut out);
        assert_eq!(out, input);
    }

    #[test]
    fn downsample_48k_length_and_amplitude() {
        let mut r = Resampler::new(48000, 16000);
        let input = sine(48000, 440.0, 1.0);
        let mut out = Vec::new();
        r.process(&input, &mut out);
        assert!((out.len() as i64 - 16000).abs() <= 2, "len {}", out.len());
        // Passband tone keeps its level (0.5 amplitude sine → rms ≈ 0.3536).
        let level = rms(&out[200..]);
        assert!((level - 0.3536).abs() < 0.02, "rms {level}");
    }

    #[test]
    fn downsample_attenuates_above_nyquist() {
        let mut r = Resampler::new(48000, 16000);
        let input = sine(48000, 12000.0, 1.0); // above the 8 kHz output Nyquist
        let mut out = Vec::new();
        r.process(&input, &mut out);
        assert!(rms(&out[200..]) < 0.05, "aliasing too strong: {}", rms(&out[200..]));
    }

    #[test]
    fn chunked_equals_one_shot() {
        let input = sine(44100, 300.0, 0.5);
        let mut a = Resampler::new(44100, 16000);
        let mut one = Vec::new();
        a.process(&input, &mut one);

        let mut b = Resampler::new(44100, 16000);
        let mut chunked = Vec::new();
        for c in input.chunks(441) {
            b.process(c, &mut chunked);
        }
        assert_eq!(one.len(), chunked.len());
        for (x, y) in one.iter().zip(chunked.iter()) {
            assert!((x - y).abs() < 1e-4);
        }
    }

    #[test]
    fn upsample_length() {
        let mut r = Resampler::new(8000, 16000);
        let mut out = Vec::new();
        r.process(&sine(8000, 200.0, 1.0), &mut out);
        assert!((out.len() as i64 - 16000).abs() <= 3, "len {}", out.len());
    }
}

//! Energy-gate VAD segmenter: cuts one continuous 16 kHz mono stream into
//! speech segments (pre-roll, hangover, min speech, hard max length with a cut
//! at the quietest nearby frame). Pure and unit-tested — the capture layer feeds
//! it and writes whatever it returns.

use std::collections::VecDeque;

pub const SAMPLE_RATE: u32 = 16_000;
/// 20 ms analysis frames.
pub const FRAME_SAMPLES: usize = (SAMPLE_RATE / 50) as usize;
const FRAME_MS: u32 = 20;

#[derive(Debug, Clone)]
pub struct VadConfig {
    /// Frame RMS (0..1 full scale) at or above which a frame counts as speech.
    pub threshold: f32,
    /// Silence that closes a segment.
    pub hangover_ms: u32,
    /// Segments with less speech than this are dropped (clicks, coughs).
    pub min_speech_ms: u32,
    /// Hard cap on a segment's length.
    pub max_segment_secs: u32,
    /// Audio kept before the first speech frame.
    pub preroll_ms: u32,
}

impl VadConfig {
    pub fn from_meeting(threshold: f32, hangover_ms: u32, max_segment_secs: u32) -> Self {
        Self {
            threshold: if threshold > 0.0 { threshold } else { 0.015 },
            hangover_ms: hangover_ms.max(200),
            min_speech_ms: 600,
            max_segment_secs: max_segment_secs.clamp(5, 600),
            preroll_ms: 300,
        }
    }

    fn frames(ms: u32) -> usize {
        ms.div_ceil(FRAME_MS) as usize
    }
}

/// A finished speech segment. `start` is the sample index on the stream's
/// timeline (16 kHz), so `t0 = start / 16000`.
#[derive(Debug, Clone)]
pub struct Segment {
    pub start: u64,
    pub samples: Vec<f32>,
}

impl Segment {
    pub fn t0(&self) -> f64 {
        self.start as f64 / SAMPLE_RATE as f64
    }
    pub fn t1(&self) -> f64 {
        (self.start + self.samples.len() as u64) as f64 / SAMPLE_RATE as f64
    }
}

struct Frame {
    samples: Vec<f32>,
    rms: f32,
}

struct Current {
    start: u64,
    frames: Vec<Frame>,
    speech_frames: usize,
    trailing_silence: usize,
}

pub struct Segmenter {
    cfg: VadConfig,
    /// Timeline index of the next sample to arrive.
    pos: u64,
    /// Incomplete frame being filled.
    partial: Vec<f32>,
    preroll: VecDeque<Frame>,
    cur: Option<Current>,
}

pub fn rms(samples: &[f32]) -> f32 {
    if samples.is_empty() {
        return 0.0;
    }
    (samples.iter().map(|v| v * v).sum::<f32>() / samples.len() as f32).sqrt()
}

impl Segmenter {
    pub fn new(cfg: VadConfig) -> Self {
        Self {
            cfg,
            pos: 0,
            partial: Vec::with_capacity(FRAME_SAMPLES),
            preroll: VecDeque::new(),
            cur: None,
        }
    }

    /// Timeline position (samples) including any partial frame.
    pub fn position(&self) -> u64 {
        self.pos + self.partial.len() as u64
    }

    /// Feed audio; returns any segments that closed.
    pub fn push(&mut self, samples: &[f32]) -> Vec<Segment> {
        let mut out = Vec::new();
        let mut rest = samples;
        while !rest.is_empty() {
            let need = FRAME_SAMPLES - self.partial.len();
            let take = need.min(rest.len());
            self.partial.extend_from_slice(&rest[..take]);
            rest = &rest[take..];
            if self.partial.len() == FRAME_SAMPLES {
                let samples = std::mem::replace(&mut self.partial, Vec::with_capacity(FRAME_SAMPLES));
                let frame_start = self.pos;
                self.pos += FRAME_SAMPLES as u64;
                let frame = Frame {
                    rms: rms(&samples),
                    samples,
                };
                if let Some(seg) = self.process_frame(frame, frame_start) {
                    out.push(seg);
                }
            }
        }
        out
    }

    /// Advance the timeline without audio (paused). Closes any open segment
    /// first — call `flush` before if you want it returned.
    pub fn skip(&mut self, n: u64) {
        self.cur = None;
        self.preroll.clear();
        self.pos = self.position() + n;
        self.partial.clear();
    }

    /// Close the open segment (stop / pause), returning it when it holds enough speech.
    pub fn flush(&mut self) -> Option<Segment> {
        let cur = self.cur.take()?;
        self.preroll.clear();
        self.finish(cur)
    }

    fn process_frame(&mut self, frame: Frame, frame_start: u64) -> Option<Segment> {
        let speech = frame.rms >= self.cfg.threshold;
        let preroll_frames = VadConfig::frames(self.cfg.preroll_ms);
        let Some(cur) = self.cur.as_mut() else {
            if speech {
                let pre: Vec<Frame> = self.preroll.drain(..).collect();
                let start = frame_start - (pre.len() * FRAME_SAMPLES) as u64;
                let mut frames = pre;
                frames.push(frame);
                self.cur = Some(Current {
                    start,
                    frames,
                    speech_frames: 1,
                    trailing_silence: 0,
                });
            } else {
                self.preroll.push_back(frame);
                while self.preroll.len() > preroll_frames {
                    self.preroll.pop_front();
                }
            }
            return None;
        };

        cur.frames.push(frame);
        if speech {
            cur.speech_frames += 1;
            cur.trailing_silence = 0;
        } else {
            cur.trailing_silence += 1;
        }

        if cur.trailing_silence >= VadConfig::frames(self.cfg.hangover_ms) {
            let cur = self.cur.take()?;
            return self.finish(cur);
        }

        let max_frames = (self.cfg.max_segment_secs * 1000 / FRAME_MS) as usize;
        if cur.frames.len() >= max_frames {
            return self.force_cut();
        }
        None
    }

    /// Max length reached: cut at the quietest frame in the last ~2 s and carry
    /// the remainder over as the start of the next segment.
    fn force_cut(&mut self) -> Option<Segment> {
        let mut cur = self.cur.take()?;
        let len = cur.frames.len();
        let window = VadConfig::frames(2000).min(len / 2);
        let search_from = len - window;
        let mut cut = len; // exclusive end of the emitted part
        let mut best = f32::MAX;
        for i in search_from..len {
            if cur.frames[i].rms <= best {
                best = cur.frames[i].rms;
                cut = i + 1;
            }
        }
        let remainder: Vec<Frame> = cur.frames.split_off(cut);
        let first = Current {
            start: cur.start,
            speech_frames: cur.frames.iter().filter(|f| f.rms >= self.cfg.threshold).count(),
            trailing_silence: 0,
            frames: cur.frames,
        };
        if !remainder.is_empty() {
            let speech_frames = remainder.iter().filter(|f| f.rms >= self.cfg.threshold).count();
            let trailing_silence = remainder
                .iter()
                .rev()
                .take_while(|f| f.rms < self.cfg.threshold)
                .count();
            self.cur = Some(Current {
                start: first.start + (first.frames.len() * FRAME_SAMPLES) as u64,
                frames: remainder,
                speech_frames,
                trailing_silence,
            });
        }
        // The emitted part never drops for lack of speech at a forced cut.
        let samples: Vec<f32> = first.frames.into_iter().flat_map(|f| f.samples).collect();
        Some(Segment {
            start: first.start,
            samples,
        })
    }

    fn finish(&self, mut cur: Current) -> Option<Segment> {
        if cur.speech_frames * (FRAME_MS as usize) < self.cfg.min_speech_ms as usize {
            return None;
        }
        // Keep at most a pre-roll's worth of trailing silence.
        let keep_tail = VadConfig::frames(self.cfg.preroll_ms);
        let trim = cur.trailing_silence.saturating_sub(keep_tail);
        let new_len = cur.frames.len() - trim;
        cur.frames.truncate(new_len);
        let samples: Vec<f32> = cur.frames.into_iter().flat_map(|f| f.samples).collect();
        Some(Segment {
            start: cur.start,
            samples,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn cfg() -> VadConfig {
        VadConfig::from_meeting(0.015, 1200, 90)
    }

    fn silence(secs: f32) -> Vec<f32> {
        vec![0.0; (SAMPLE_RATE as f32 * secs) as usize]
    }

    fn tone(secs: f32) -> Vec<f32> {
        let n = (SAMPLE_RATE as f32 * secs) as usize;
        (0..n)
            .map(|i| (2.0 * std::f32::consts::PI * 220.0 * i as f32 / SAMPLE_RATE as f32).sin() * 0.2)
            .collect()
    }

    fn run(seg: &mut Segmenter, parts: &[Vec<f32>]) -> Vec<Segment> {
        let mut out = Vec::new();
        for p in parts {
            // Feed in odd-sized chunks to exercise the partial-frame path.
            for c in p.chunks(333) {
                out.extend(seg.push(c));
            }
        }
        out.extend(seg.flush());
        out
    }

    #[test]
    fn silence_yields_nothing() {
        let mut s = Segmenter::new(cfg());
        assert!(run(&mut s, &[silence(10.0)]).is_empty());
    }

    #[test]
    fn single_utterance_with_preroll() {
        let mut s = Segmenter::new(cfg());
        let segs = run(&mut s, &[silence(2.0), tone(2.0), silence(3.0)]);
        assert_eq!(segs.len(), 1);
        let seg = &segs[0];
        assert!((seg.t0() - 1.7).abs() < 0.03, "t0 {}", seg.t0());
        // 2 s speech + ≤0.3 s preroll + ≤0.3 s tail
        assert!(seg.t1() - seg.t0() <= 2.65 && seg.t1() - seg.t0() >= 2.2, "len {}", seg.t1() - seg.t0());
    }

    #[test]
    fn short_blip_is_dropped() {
        let mut s = Segmenter::new(cfg());
        assert!(run(&mut s, &[silence(1.0), tone(0.2), silence(3.0)]).is_empty());
    }

    #[test]
    fn short_pause_stays_one_segment_long_pause_splits() {
        let mut s = Segmenter::new(cfg());
        let segs = run(&mut s, &[tone(1.0), silence(0.5), tone(1.0), silence(3.0)]);
        assert_eq!(segs.len(), 1);

        let mut s = Segmenter::new(cfg());
        let segs = run(&mut s, &[tone(1.0), silence(2.0), tone(1.0), silence(3.0)]);
        assert_eq!(segs.len(), 2);
        assert!(segs[1].t0() > segs[0].t1());
    }

    #[test]
    fn max_length_forces_contiguous_cut() {
        let mut c = cfg();
        c.max_segment_secs = 10;
        let mut s = Segmenter::new(c);
        let segs = run(&mut s, &[tone(25.0), silence(3.0)]);
        assert_eq!(segs.len(), 3, "{:?}", segs.iter().map(|s| (s.t0(), s.t1())).collect::<Vec<_>>());
        // Contiguous: each segment starts where the previous one ended.
        assert!((segs[1].t0() - segs[0].t1()).abs() < 1e-9);
        assert!((segs[2].t0() - segs[1].t1()).abs() < 1e-9);
        assert!(segs[0].t1() - segs[0].t0() <= 10.0 + 1e-9);
    }

    #[test]
    fn skip_advances_timeline() {
        let mut s = Segmenter::new(cfg());
        s.skip(SAMPLE_RATE as u64 * 5);
        let segs = run(&mut s, &[tone(1.0), silence(2.0)]);
        assert_eq!(segs.len(), 1);
        assert!((segs[0].t0() - 5.0).abs() < 0.01);
    }
}

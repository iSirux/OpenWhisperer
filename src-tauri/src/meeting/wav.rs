//! Minimal PCM WAV encoding (16-bit mono) for meeting segments.

/// Encode mono f32 samples (-1..1) as a 16-bit PCM WAV file.
pub fn encode_wav_i16(samples: &[f32], sample_rate: u32) -> Vec<u8> {
    let data_len = (samples.len() * 2) as u32;
    let mut out = Vec::with_capacity(44 + data_len as usize);
    out.extend_from_slice(b"RIFF");
    out.extend_from_slice(&(36 + data_len).to_le_bytes());
    out.extend_from_slice(b"WAVE");
    out.extend_from_slice(b"fmt ");
    out.extend_from_slice(&16u32.to_le_bytes()); // fmt chunk size
    out.extend_from_slice(&1u16.to_le_bytes()); // PCM
    out.extend_from_slice(&1u16.to_le_bytes()); // mono
    out.extend_from_slice(&sample_rate.to_le_bytes());
    out.extend_from_slice(&(sample_rate * 2).to_le_bytes()); // byte rate
    out.extend_from_slice(&2u16.to_le_bytes()); // block align
    out.extend_from_slice(&16u16.to_le_bytes()); // bits per sample
    out.extend_from_slice(b"data");
    out.extend_from_slice(&data_len.to_le_bytes());
    for s in samples {
        let v = (s.clamp(-1.0, 1.0) * i16::MAX as f32).round() as i16;
        out.extend_from_slice(&v.to_le_bytes());
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn header_and_length() {
        let wav = encode_wav_i16(&[0.0, 1.0, -1.0, 2.0], 16000);
        assert_eq!(&wav[0..4], b"RIFF");
        assert_eq!(&wav[8..12], b"WAVE");
        assert_eq!(wav.len(), 44 + 8);
        assert_eq!(u32::from_le_bytes(wav[40..44].try_into().unwrap()), 8);
        assert_eq!(u32::from_le_bytes(wav[24..28].try_into().unwrap()), 16000);
        // 1.0 and the clamped 2.0 both map to i16::MAX
        assert_eq!(i16::from_le_bytes([wav[46], wav[47]]), i16::MAX);
        assert_eq!(i16::from_le_bytes([wav[50], wav[51]]), i16::MAX);
        assert_eq!(i16::from_le_bytes([wav[48], wav[49]]), -i16::MAX);
    }
}

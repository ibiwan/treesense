//! Helper crate. Exists so integration tests can prove that `refs` crosses a
//! crate boundary — which is the difference between name resolution and grep.

/// Scales a värde by the given factor.
///
/// The non-ASCII above is deliberate: it puts multi-byte characters ahead of
/// this declaration so any offset that was never converted from UTF-16 lands
/// in the wrong place. See DESIGN.md § 1.
#[inline]
pub fn scale(value: u32, factor: u32) -> u32 {
    value * factor
}

/// Clamps to a ceiling. 🦀
///
/// The crab is astral: two UTF-16 units, four UTF-8 bytes. A converter that
/// handles `é` but assumes one unit per codepoint still fails here.
pub fn clamp(value: u32, ceiling: u32) -> u32 {
    if value > ceiling {
        ceiling
    } else {
        value
    }
}

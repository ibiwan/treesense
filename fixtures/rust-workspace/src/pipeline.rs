use helper::{clamp, scale};

/// Runs the pipeline over a seed värde.
///
/// Deliberately nests `if` inside `for` inside `fn` so the ancestor chain has
/// something to report between `node` and `item` — the gap that motivates
/// returning a hierarchy rather than only the enclosing declaration.
#[inline]
pub fn run(seed: u32) -> u32 {
    let mut total = 0;

    for step in 0..3 {
        if step % 2 == 0 {
            // Bare identifier argument: traceable into `scale`.
            total += scale(seed, step);
        } else {
            // Argument is an expression, not a bare identifier. `trace` must
            // stop here reporting `non-ident-arg` rather than following it.
            total += scale(seed + 1, step);
        }
    }

    clamp(total, 100)
}

#[cfg(test)]
mod tests {
    use super::run;

    #[test]
    fn runs_to_completion() {
        assert!(run(2) <= 100);
    }
}

/// Decoration cases for `trace`. A borrow, a parenthesis and a zero-argument
/// method call are all still the same name: the walk must peel them and carry
/// on, not stop at the wrapper. Reverting any of these to a bare identifier
/// deletes the coverage without failing anything loudly — don't.
pub fn decorated(seed: u32) -> u32 {
    let one = borrowed(&seed);
    let two = borrowed(&(seed.clone()));
    one + two
}

/// Named separately from `scale` so the decoration test has a callee whose
/// parameter is not reachable by any other route.
pub fn borrowed(carried: &u32) -> u32 {
    *carried
}

use helper::scale;

mod pipeline;

fn main() {
    // Same-scope rebinding: `raw` below is a DIFFERENT binding from `raw`
    // above. Rust and the ML family allow this; most languages need a nested
    // block. It is the cheapest demonstration that a handle asserts byte
    // identity and not semantic identity — inserting a third `let raw` here
    // changes what the `raw` on the next line means without touching a byte
    // of it. See DESIGN.md § 4. Do not "tidy" this away.
    let raw = 7;
    let raw = raw + 1;

    // Bare identifier argument: `trace` can follow this one into `scale`.
    let scaled = scale(raw, 3);

    // Macro: `trace` must stop here and say `macro`, not simply end.
    println!("scaled = {scaled}");

    pipeline::run(scaled);
}

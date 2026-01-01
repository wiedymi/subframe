# Goals for subframe

## Vision
Build a WebGL-first subtitle renderer that targets 1:1 visual parity with libass for ASS/SSA on web and Bun, with a path to WebGPU.

## v0 scope (must-have)
- [ ] Core ASS layout + tag engine: \fs, \fscx, \fscy, \fsp, \bord, \shad, \blur, \be, \c, \alpha, \an, \pos, \move, \org, \q.
- [ ] Wrapping, margins, alignment, and line breaking consistent with libass.
- [ ] Karaoke: \k, \kf, \ko.
- [ ] Clip: \clip / \iclip.
- [ ] Animation: \t, \fade, \fad.
- [ ] 3D transforms: \frx, \fry, \frz, \fax, \fay.
- Core ASS layout + tag engine: \fs, \fscx, \fscy, \fsp, \bord, \shad, \blur, \be, \c, \alpha, \an, \pos, \move, \org, \q.
- Wrapping, margins, alignment, and line breaking consistent with libass.
- Karaoke: \k, \kf, \ko.
- Clip: \clip / \iclip.
- Animation: \t, \fade, \fad.
- 3D transforms: \frx, \fry, \frz, \fax, \fay.

## Non-goals (initially)
- [ ] Full ASS feature coverage outside the scope list.
- [ ] Multiple build targets or separate browser/Bun builds.
- [ ] Heavy optional dependencies or native addons.
- Full ASS feature coverage outside the scope list.
- Multiple build targets or separate browser/Bun builds.
- Heavy optional dependencies or native addons.

## Constraints
- [ ] Single build that runs in browser and Bun.
- [ ] Minimal dependencies; keep subframe separate from subforge core (monorepo allowed).
- [ ] No false claims in docs; only document implemented features.
- Single build that runs in browser and Bun.
- Minimal dependencies; keep subframe separate from subforge core (monorepo allowed).
- No false claims in docs; only document implemented features.

## Success criteria
- [ ] Pixel-diff parity against libass for a representative test suite.
- [ ] Deterministic output given the same inputs (fonts, timestamps, config).
- [ ] Clear instrumentation for debugging layout/rasterization differences.
- Pixel-diff parity against libass for a representative test suite.
- Deterministic output given the same inputs (fonts, timestamps, config).
- Clear instrumentation for debugging layout/rasterization differences.

## Quality targets
- [ ] Internal geometry uses 1/64 px fixed point (SUBPIXEL_MASK = 63).
- [ ] No unstable ordering; rendering is stable across runs.
- [ ] Debug tooling makes mismatches actionable within minutes.
- Internal geometry uses 1/64 px fixed point (SUBPIXEL_MASK = 63).
- No unstable ordering; rendering is stable across runs.
- Debug tooling makes mismatches actionable within minutes.

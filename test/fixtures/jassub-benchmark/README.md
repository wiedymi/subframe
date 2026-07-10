# JASSUB Benchmark Fixtures

Mirrored from `ThaUnknown/jassub` branch `gh-pages` at commit `9160454483540ef64581b6c6d13fcd99451a6151`.

Source:
- Repo: https://github.com/ThaUnknown/jassub
- Benchmark page: https://jassub.pages.dev/
- Source metadata: `src/lib/constants.ts` on the `gh-pages` branch

This bundle contains the subtitle, font, and local video assets used by that benchmark page. External videos referenced by the page are kept as URLs in `manifest.json` because they are not stored in the GitHub branch.

## Provenance and license status

Every file below was copied byte-for-byte from the pinned upstream commit and is used only as repository test data. The upstream benchmark repository does not provide an asset-level license manifest, and its site package is marked private; copying an asset from that commit does not establish redistribution rights.

- `subtitles/*`: source path `subtitles/<same filename>`; author and license not recorded upstream.
- `fonts/*`: source path `fonts/<same filename>`; each font's license must be verified from its original foundry/distribution before redistribution. In particular, filenames such as Arial, Slate Pro, and FOT do not imply an open license.
- `videos/*`: source path `videos/<same filename>`; media copyright/license not recorded upstream.
- `manifest.json`: repository-authored metadata derived from upstream `src/lib/constants.ts` at the pinned commit.

The npm `files` allowlist excludes all fixtures. Do not copy this bundle into packages, demos, or published benchmark artifacts without independently clearing each asset.

## Layout

- `subtitles/`: upstream ASS fixtures.
- `fonts/`: upstream font files used by the benchmark cases.
- `videos/`: local videos stored in the upstream branch.
- `manifest.json`: benchmark metadata plus a `bench:fixtures` compatible case list.

## Running

Use the existing fixture benchmark with the bundled fonts:

```sh
bun run bench:fixtures -- --manifest test/fixtures/jassub-benchmark/manifest.json --fonts test/fixtures/jassub-benchmark/fonts --fps 60
```

The `variable` and `high` cases use the same subtitle file; the upstream benchmark distinguishes them by VFR/CFR video timing. The direct Bun fixture benchmark measures subtitle rendering work only, so those two cases are expected to be equivalent here.

The stress-case timestamps in `manifest.json` target high active-event windows in each ASS file, matching the upstream page's "highest measured frametime" intent better than always sampling from media time zero.

# Deterministic parity fonts

The font files under `files/` are pinned test assets from `google/fonts` commit
`ec0464b978de222073645d6d3366f3fdf03376d8`:

- `Lato-Regular.ttf` from `ofl/lato/Lato-Regular.ttf`
- `Amiri-Regular.ttf` from `ofl/amiri/Amiri-Regular.ttf`
- `NotoSansHebrew-Regular.ttf`, instantiated at `wght=400,wdth=100` from
  `ofl/notosanshebrew/NotoSansHebrew[wdth,wght].ttf`
- `NotoSansSC-SmokeSubset-Regular.ttf`, generated from
  `ofl/notosanssc/NotoSansSC[wght].ttf` with fonttools using
  `CJK_SUBSET.txt`, then instantiated at `wght=400`

Each upstream OFL file is retained beside the fonts. The CJK subset is a
modified font under the same OFL 1.1 terms; the upstream reserved font name is
`Source`, which is not used by the subset's retained Noto names.

Generation commands (fonttools 4.59.2):

```sh
fonttools varLib.instancer 'NotoSansHebrew[wdth,wght].ttf' wght=400 wdth=100 \
  --output NotoSansHebrew-Regular.ttf
pyftsubset 'NotoSansSC[wght].ttf' --text-file=CJK_SUBSET.txt \
  --layout-features='*' --glyph-names --symbol-cmap --legacy-cmap \
  --notdef-glyph --notdef-outline --recommended-glyphs \
  --output-file=NotoSansSC-SmokeSubset-VF.ttf
fonttools varLib.instancer NotoSansSC-SmokeSubset-VF.ttf wght=400 \
  --output NotoSansSC-SmokeSubset-Regular.ttf
```

SHA-256:

```text
d636e4683231f931eda222d588e944d082bfd3bdba02f928bee461c0f185b251  Lato-Regular.ttf
ab391c4147d054c48976e98322ad0eefe1427aa0e0502a12a4c75d80a70cfcd7  Amiri-Regular.ttf
8289ced57fa1ce7862a350a951b8118ea03def6adaf46145680bc02a2c2e751f  NotoSansHebrew-Regular.ttf
be5c08e0afca15d5f020ff4e41b2966cd066979e80eeea222e7cf240c2459e8e  NotoSansSC-SmokeSubset-Regular.ttf
```

The parity manifest points both libass and Subframe at `files/` so libass does
not attempt to parse the license and provenance text as fonts. Tests
must not fall back to machine-local fonts.

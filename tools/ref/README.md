# Reference renderer (libass)

This tool renders a single ASS frame using libass and outputs a PNG.

## Build (macOS, using submodule)
```
tools/ref/build_libass.sh
```

Then build the render helper:
```
cc -O2 -Irefs/libass/libass -Itools/ref -o tools/ref/render_libass \
  tools/ref/render_libass.c \
  -Lrefs/libass/libass/.libs -lass \
  $(pkg-config --libs freetype2 fribidi harfbuzz)
```

If libass is not built yet, run `tools/ref/build_libass.sh` first.

## Usage
```
DYLD_LIBRARY_PATH=refs/libass/libass/.libs ./tools/ref/render_libass \
  --ass test/fixtures/ass/benchmark.ass \
  --time 10000 \
  --w 1920 --h 1080 \
  --out /tmp/ref.png
```

Optional fonts dir:
```
DYLD_LIBRARY_PATH=refs/libass/libass/.libs ./tools/ref/render_libass \
  --ass test/fixtures/ass/benchmark.ass \
  --time 10000 \
  --w 1920 --h 1080 \
  --fonts /path/to/fonts \
  --out /tmp/ref.png
```

Notes:
- The font provider is autodetected by libass (CoreText on macOS).
- If you require determinism, use a local fonts dir but do not commit proprietary fonts.

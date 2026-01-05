# subframe

Placeholder package to reserve the name. This project is in early development and will be updated soon with a full implementation, documentation, and examples.

Planned: a WebGL/WebGPU subtitle renderer targeting libass visual parity for web and Bun.

## Parity quickstart (smoke)
1) Build libass (submodule): `tools/ref/build_libass.sh`
2) Build the render helper (see `tools/ref/README.md`)
3) Run the smoke parity test:
```
bun run test:golden:smoke -- --trace-on-fail
```

## Submodules
This repo uses reference submodules for implementation parity research:
```
git submodule update --init --recursive
```

See `refs/README.md` for details.

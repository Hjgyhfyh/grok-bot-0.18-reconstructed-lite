# Renderer source

This directory contains the editable React/TypeScript renderer reconstruction.
It is built with Vite and ships inside the Windows folder that
`npm run package:win` writes to `dist\DB Bot\`.

The small files under `manifests/` identify assets and reviewed semantic
boundaries. There is no checksum-pinned upstream renderer in this repository
any more: every line under `frontend/src` is compiled from these sources.

Run the editable renderer checks from the repository root:

```sh
npm run typecheck
npm run frontend:build
```

Comments beginning with `@evidence` point to byte or symbol boundaries in the
reconstructed 0.18.0 renderer. They are provenance annotations, not imports.

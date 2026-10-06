# Architecture

The repository keeps two editable source roots:

- `source/` contains the Electron main, host, coordinator, local-exec, shared,
  and protocol reconstruction.
- `frontend/` contains the React renderer reconstruction.

Everything is built from these two roots. There is no upstream build input left:
the checksum-pinned 0.18.0 bundle and its `src/app/dist` tree were removed with
the scripts that read them. `npm run build` (`scripts/build-from-source.mjs`)
compiles every runtime with esbuild, builds the renderer with Vite, stages
`.build/app/` and writes `.build/app.asar`. `npm run package:win`
(`scripts/package-windows-lite.mjs`) turns that archive into the ready folder
`dist\DB Bot\`. Comments of the form `// @evidence src/app/dist/...` remain as a
record of where the interface strings came from; nothing in the build opens
those paths.

Small manifests remain checked in only where the build consumes them directly.
Large recovery reports, source capsules, rejected candidate evidence, and
screenshots live only in the private forensic history and are not part of this
branch's product tree.

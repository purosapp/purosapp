# Working on Puros providers (API v1)

Core owns SQLite library/catalog identity, source priority, queue, decoding, DSP, CoreAudio output, cache quotas, and every React view. A provider owns its remote authentication/API, catalog mapping, library enumeration, quality choices, file download/decryption, and optional metadata.

**The authoring guide is public:** the contract, CLI, package format, manifest reference, capability/lifecycle rules and playback/cache rules live in the SDK's [`README.md`](../../provider-sdk/README.md) ([puros-provider-sdk](https://github.com/purosapp/puros-provider-sdk)). This file covers only working on providers inside a Puros checkout.

## Repositories

Puros core (GPL-3.0) lives in this repository; the SDK and the providers are separate MIT repositories, cloned in place and ignored by this repository ([`repos.json`](../../repos.json)):

| Directory | Repository |
| --- | --- |
| `provider-sdk/` | `puros-provider-sdk`: Provider API v1 (`src/`), the `puros-provider` CLI and build tooling (`tooling/`), a public example (`example/`). Published to npm as `puros-provider-sdk`. |
| `providers/soundcloud`, `providers/spotify`, `providers/tidal`, `providers/youtube-music` | `puros-provider-<id>`: one provider each, with a macOS GitHub Actions workflow that packages it and publishes tagged releases. |
| `providers-list/` | `purosapp/providers-list`: the public README listing official and unofficial providers. Add a row when a provider is published. |
| `providers/_example` | Tracked here: the core contract fixture. |

```sh
npm run repos:clone     # clone missing checkouts, then build provider-sdk/dist (editor types)
npm run repos:pull      # git pull --ff-only in each checkout
npm run repos:status    # branch and change count of puros and every checkout
```

Clone before `npm install`: `puros-provider-sdk` is linked as `file:provider-sdk`. Commit and push each repository on its own; `repos:status` shows which ones have changes.

- **Core** imports the contract through [`src/provider-api/v1/index.ts`](../../src/provider-api/v1/index.ts), a re-export of `provider-sdk/src`. Change the contract in `provider-sdk/` and release a new SDK version before providers depend on it.
- **Providers** import only `puros-provider-sdk`, Node.js built-ins, their own npm dependencies and their own files. `vite.config.ts`, `vitest.config.ts` and `tsconfig.json` alias `puros-provider-sdk` to `provider-sdk/src`, so in-repository builds and tests always use the checked-out contract; the provider repositories use the published package. `npm run check:boundaries` fails when a provider imports a file outside its directory.
- **Build tooling** (manifest validation, build steps, the packer, keygen, the pinned ffmpeg/libsoxr recipes) lives in `provider-sdk/tooling/`; `scripts/providers.mjs`, `provider-package.mjs`, `provider-keygen.mjs`, `build-ffmpeg.mjs`, `build-soxr.mjs` and `verify-package-secrets.mjs` wrap it. Helper builds call `node "$PUROS_PROVIDER_CLI" ffmpeg --install=…`, which the SDK sets for every build step.
- **Host-coupled tests** stay here: [`tests/providers/`](../../tests/providers/) holds the opt-in live tests that drive provider code through core's helper argument and environment rules (`PUROS_SC_NETWORK_TEST=1`, `PUROS_YTM_NETWORK_TEST=1`). They are skipped while the provider checkout is absent.
- **Tidal's helper** uses its own `providers/tidal/.venv` (`providers/tidal/helper/setup-python.sh`, pinned `helper/requirements.txt`).

## Layout and selection

A provider directory holds `provider.manifest.json`, `src/index.ts`, optional `assets/` and `helper/`. Its directory name must match the manifest ID here (`_example`/`example` is the one exception).

`scripts/providers.mjs` reads manifests and generates a manifest-only main registry, a separate static-import utility-process registry, and the electron-builder resource configuration. Do not edit generated files. Release builds select no providers unless `PUROS_PROVIDERS` is set; development/test defaults to the example fixture. Examples:

```sh
PUROS_PROVIDERS=tidal npm run dev
PUROS_PROVIDERS=tidal npm run build:mac-local
PUROS_PROVIDERS=none npm run build:mac-local
PUROS_PROVIDERS=all npm run build:mac-local
npm run providers:pack -- <id|all> [--skip-build] [--out=<dir>] [--sign-key=<pem>]   # packs from the provider root, like its CI
npm run test:provider -- example
npm run check:all
```

`PUROS_PROVIDERS` also accepts comma-separated IDs and only sees checkouts that exist. Release `all` excludes the example.

Last.fm scrobbling is built into core and remains available with `PUROS_PROVIDERS=none`. Set `LASTFM_API_KEY` and `LASTFM_API_SECRET` in the build environment or the repository's ignored `.env`/`.env.local` before building. Vite includes only those app credentials in the Electron main-process bundle; no dotenv file is packaged, and renderer, preload, and provider bundles do not receive them. The packaged app uses these credentials without requiring runtime environment variables. A build without them shows Last.fm as unconfigured.

## Isolation, tests, and review

Each selected plugin runs in its own Electron `utilityProcess` over a versioned `MessagePort`, with a provider-data `cwd`, restricted environment, call deadlines, payload/event bounds, and crash/restart policy. **This is not an OS sandbox.** Provider code still has Node.js filesystem/process APIs and unrestricted network access; manifest origins are declarations and host-browser policy, not network filtering. Only install or ship reviewed provider code and review helper binaries/licenses/remote-service terms separately.

Run `npm run test:provider -- <id>` before proposing a plugin. It builds declared provider artifacts, typechecks, then applies the same offline contract suite to that ID: manifest/runtime agreement, capability shape, cloneable status/auth, cache-path rejection, error behavior, and teardown. It packages only that provider in a temporary repo copy, launches the app, and checks renderer state. The example additionally exercises actual file resolution and worker crash/flood recovery. Real-account methods are not called by this offline suite; attach manual auth/catalog/playback QA for those. `npm run check:all` builds the core native addon, runs source gates, verifies generation for none/all/each, and runs zero/one-provider package/renderer gates. It requires macOS build tools, working ffmpeg, installed npm dependencies, and any selected provider's build prerequisites (for Tidal, `providers/tidal/.venv`). Both scripts restore the development Electron native-module ABI afterward. `npm run verify:provider-packages` (also part of `check:all`) packs every provider twice from existing build outputs, requires identical bytes and a valid `unzip -t`, loads each compiled entry with Electron's embedded Node.js, and runs the same offline contract against the extracted packages.

In a review, include the manifest/capability diff, packaged resource list, proof that a `providers/`-deleted build still launches, a populated-data migration check for any persistence change, and the manual audio matrix when playback code changes. Do not modify native C++ to integrate a provider unless the public file-artifact boundary is proven insufficient and the user explicitly approves that risk.

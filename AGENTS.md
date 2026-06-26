# Just Every Plugins Repository Guide

This repository is the Just Every Codex plugin marketplace for plugins published by Just Every. Marketplace metadata lives at `.agents/plugins/marketplace.json`; plugin implementations live in their own Just Every-owned repositories.

Ultracode now lives in the sibling repository `../plugin-ultracode` and is exposed here through a Git-backed marketplace entry.

## Main Components

- `.agents/plugins/marketplace.json` declares the `just-every` marketplace and lists installable Just Every plugins.
- Root `package.json` is the marketplace-level package (`@just-every/plugins`) and validates the catalog metadata.
- Root `README.md` explains the marketplace install path.

## Development Notes

- Keep this repository as a thin catalog. Do not reintroduce plugin implementation code here unless the marketplace format genuinely requires a local source.
- Only add plugins published and maintained by Just Every. Do not add third-party, community, or externally owned plugin repositories to this catalog.
- Add new plugins as Git-backed entries that point at their Just Every-owned plugin repositories.
- Keep marketplace docs and metadata in sync whenever a plugin repository, ref, policy, or category changes.
- Run `npm test` after editing catalog metadata.
- Do not commit local `.claude/` files or `.DS_Store`.

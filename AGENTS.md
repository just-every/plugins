# Just Every Plugins Repository Guide

This repository is the Just Every Codex plugin marketplace. Marketplace metadata lives at `.agents/plugins/marketplace.json`; plugin implementations live in their own repositories.

Ultracode now lives in the sibling repository `../plugin-ultracode` and is exposed here through a Git-backed marketplace entry.

## Main Components

- `.agents/plugins/marketplace.json` declares the `just-every` marketplace and lists installable plugins.
- Root `package.json` is the marketplace-level package (`@just-every/plugins`) and validates the catalog metadata.
- Root `README.md` explains the marketplace install path.

## Development Notes

- Keep this repository as a thin catalog. Do not reintroduce plugin implementation code here unless the marketplace format genuinely requires a local source.
- Add new plugins as Git-backed entries that point at their plugin-owned repositories.
- Keep marketplace docs and metadata in sync whenever a plugin repository, ref, policy, or category changes.
- Run `npm test` after editing catalog metadata.
- Do not commit local `.claude/` files or `.DS_Store`.

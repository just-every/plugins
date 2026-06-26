# Just Every Plugins

Codex plugin marketplace for Just Every.

This repository is a marketplace source for plugins published by Just Every. Add it to Codex once, then install or update the plugins exposed by the catalog.

## Plugins

| Icon | Plugin | Purpose |
| --- | --- | --- |
| <img src="https://raw.githubusercontent.com/just-every/plugin-ultracode/main/assets/icon.png" alt="Ultracode icon" width="32" height="32"> | [Ultracode](https://github.com/just-every/plugin-ultracode) | Parallel Codex worker workflows for investigation, planning, review, pipelines, and scripted orchestration. |
| <img src="https://raw.githubusercontent.com/just-every/plugin-auto-review/main/assets/icon.png" alt="Auto Code Review icon" width="32" height="32"> | [Auto Code Review](https://github.com/just-every/plugin-auto-review) | Hook-driven review of Codex edits at turn stop with strict schema-validated reviewer output. |

## Marketplace Layout

```text
.agents/plugins/marketplace.json
```

The marketplace id is `just-every`. Plugin entries point at Just Every-owned source repositories, so this repo stays a small catalog while each plugin owns its implementation, tests, and releases.

## Install

From a published GitHub repository:

```bash
codex plugin marketplace add just-every/plugins
```

From this local checkout:

```bash
codex plugin marketplace add /path/to/just-every/plugins
```

After pulling new changes:

```bash
codex plugin marketplace upgrade just-every
```

## Development

Validate the marketplace catalog:

```bash
npm test
```

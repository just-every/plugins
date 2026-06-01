# Just Every Plugins

Codex plugin marketplace for Just Every.

This repository is a marketplace source. Add it to Codex once, then install or update the plugins exposed by the catalog.

## Plugins

| Plugin | Purpose |
| --- | --- |
| [Ultracode](https://github.com/just-every/plugin-ultracode) | Parallel Codex worker workflows for investigation, planning, review, pipelines, and scripted orchestration. |

## Marketplace Layout

```text
.agents/plugins/marketplace.json
```

The marketplace id is `just-every`. Plugin entries point at their source repositories, so this repo stays a small catalog while each plugin owns its implementation, tests, and releases.

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

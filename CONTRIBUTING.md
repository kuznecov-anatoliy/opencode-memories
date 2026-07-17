# Contributing

## Getting Started

1. Fork the repository
2. Clone your fork
3. Run `npm install`
4. Add the plugin to your OpenCode config

## Development

The plugin is written in TypeScript and runs as an OpenCode plugin.

### Structure

- `src/memories-v5.9.ts` — main plugin entry point
- All state management, storage, and tool registration are in a single file

### Testing

- Run `npm test` before submitting a PR
- Add tests for new functionality

## Pull Request Process

1. Update CHANGELOG.md with your changes
2. Ensure CI passes (lint + test)
3. Submit a PR with a clear description of what and why

## Code Style

- TypeScript with strict types
- No external runtime dependencies beyond `@opencode-ai/plugin` and `sql.js-fts5`
- Console logging for diagnostics is acceptable, but prefer structured error reporting

# Contributing

Use Node.js 22.12+ and pnpm 11. Install with `pnpm install --frozen-lockfile`, run `pnpm run setup`, and copy `config.example.json` to the ignored `config.json`. Create a local `media/` directory and adjust the configuration for your display.

Run `pnpm test` before submitting changes. For UI, playback, socket or window-management changes, also run the relevant [desktop tests](tests/README.md). A DOM assertion alone does not verify what the audience sees: transition changes should retain the rendered-pixel regression test. Keep runtime resources local and preserve offline operation after development dependencies are installed.

Bug reports should include the version, OS, reproduction steps and expected/actual behavior. Include a minimal synthetic media sample when needed. Remove private URLs, paths and profile contents from logs or screenshots before sharing. Do not commit personal configurations, browser data, presentation media or generated builds.

Keep pull requests focused and explain the behavior changed and validation performed. Contributions to original project code and documentation are accepted under the same CC0 1.0 dedication. Third-party additions must retain their license information. There is currently no automated release process.

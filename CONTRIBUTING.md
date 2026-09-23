# Contributing

Thanks for taking an interest. Issues and pull requests are both welcome.

## Getting set up

You need pnpm and a Node version matching `engines` in `package.json`, then

```
pnpm install
pnpm dev
```

`pnpm dev` rebuilds `main.js` on every save. Copy `main.js`, `manifest.json` and `styles.css` into `.obsidian/plugins/micropatches/` in a vault you do not mind breaking. You can also symlink them there so each rebuild shows up straight away.

## Before you open a pull request

```
pnpm verify
```

That runs formatting, lint, dead code, types, the unit tests and the build. CI runs the same command and adds the community plugin directory's own checks, so a green local run should mean a green pull request.

Pull request titles follow [Conventional Commits](https://www.conventionalcommits.org), so `fix: ...`, `feat: ...` or `docs: ...`.

New behaviour wants a test next to the patch, in `src/patches/<id>.test.ts`. Tests run against [obsidian-test-mocks](https://github.com/mnaoumov/obsidian-test-mocks).

## Worth knowing

A new patch is one file in `src/patches/` plus one line in `src/main.ts`, and it starts off by default. `AGENTS.md` explains how a patch has to clean up after itself. Reading it first will save you a review round.

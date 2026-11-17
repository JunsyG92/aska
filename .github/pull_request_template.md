<!--
The PR title becomes the commit message on main: it must follow
Conventional Commits, for example "feat(notifications): optional sound" or
"fix(windows): .cmd launcher not found". See CONTRIBUTING.md.
-->

## What and why

<!-- The change in a few lines, and the need it covers. "Closes #123" if there is an issue. -->

## How it was verified

<!-- Tests added or changed, manual testing (OS, agent, desktop). -->

## Screenshots

<!-- For any visible change: before / after, in light and dark if possible. -->

## Checklist

- [ ] Security: does this change touch agent launching, permissions, folders or the environment passed on? If so, explain.
- [ ] Tests pass locally (`npm run check`, and `npm run test:e2e` for the UI).
- [ ] Documentation up to date (README, `aska --help`) if the behavior changes.

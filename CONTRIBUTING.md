# Contributing to Aska

Thanks for your interest! This guide describes how the project is organized, so that
every contribution reaches `main` the same way: reviewed, tested, and versioned.

## At a glance

1. Create a branch from `main`: `feat/notification-sound`, `fix/windows-launcher`...
2. Write the code, with tests. Check locally: `npm run check`.
3. Open a PR to `main` with a [Conventional Commits](https://www.conventionalcommits.org/) title:
   `feat(notifications): optional sound`.
4. CI must be green and a reviewer (see `CODEOWNERS`) must approve.
5. The PR is **squash**-merged: one commit per PR on `main`, with the PR title.
6. The version and the CHANGELOG are updated automatically (see [Releases](#versions-and-releases)).

## Branches

The project follows **GitHub Flow**: a single permanent branch, `main`, always
stable and protected. Everything else goes through short-lived branches and PRs.

| Branch | Role |
| --- | --- |
| `main` | Default branch, protected: no direct push, no force-push, linear history. |
| `feat/...`, `fix/...`, `docs/...`, `refactor/...`, `ci/...`, `chore/...` | Work branches, one per topic, deleted after merge. |
| `release-please--...` | Created by the release bot, do not edit by hand. |

Keep branches short-lived (a few days) and rebase them on `main` if they
diverge: the protection requires an up-to-date branch before merging.

## PR titles and commit messages

The PR title becomes the commit message on `main`, and it is what
determines the next version number and the CHANGELOG line. CI checks
its format: `<type>(<optional scope>): <description>`.

| Type | When | Effect on the version |
| --- | --- | --- |
| `feat` | new feature | minor version |
| `fix` | bug fix | patch |
| `perf` | performance improvement | patch |
| `refactor` | restructuring without behavior change | none |
| `docs` | documentation | none |
| `test` | tests only | none |
| `build` | dependencies, tooling | none |
| `ci` | GitHub Actions | none |
| `chore` | miscellaneous | none |
| `revert` | reverting a change | patch |

A **breaking** change (renamed configuration, changed default
behavior...) takes a `!`: `feat(config)!: rename "notify" to "notifications"`, and
the PR description explains the migration.

Common scopes: `ui`, `agents`, `notifications`, `history`, `models`,
`security`, `windows`, `linux`, `install`, `ci`, `docs`.

## Review

- At least **one approval** is required; `CODEOWNERS` designates the reviewers.
- A new change after approval dismisses the approval (review needed again).
- All review conversations must be resolved before merging.
- Changes that touch **agent launching** (`src/main/launch.js`,
  `runner.js`, `security.js`), **permission modes** or the **environment
  passed on** need particular care: explain them in the PR.

## Development

Requirements: Node.js ≥ 20 (`.nvmrc` gives the CI version).

```sh
npm install
npm start                     # runs the application
npm run lint                  # ESLint
npm test                      # unit tests
xvfb-run -a npm run test:e2e  # end-to-end test (Linux); on Windows: npm run test:e2e
npm run check                 # lint + unit tests, before every push
```

Two tests complement it: `test/e2e/instances.js` (replacing an old Aska
instance) and, on Linux only, `npm run test:click` (a real click on another
window, under Openbox; needs `openbox`, `xdotool` and `xterm`).

The end-to-end test runs the real application with fake agent CLIs
(`test/fixtures/fake-agent.js`): it needs no account and no key.

If your change modifies the UI, regenerate the README images:

```sh
xvfb-run -a -s "-screen 0 3200x2000x24" node scripts/readme-media.js
```

### Code rules

- **Never a shell** to launch an agent: arguments as an array, request on
  stdin or as a single argument (see `src/main/launch.js`).
- The UI stays sandboxed: no Node in `src/renderer/`, no
  `innerHTML` on content coming from an agent.
- Every call from the UI is revalidated in the main process.
- Documentation in English; UI text goes through the translations (see below).
- A bug fix comes with the test that would have caught it.

### Translations

Every user-visible string (window, notifications, errors, `aska --help`)
lives in `src/i18n/`: `en.js` is the reference, `fr.js` the French version.
Code calls `t('namespace.key', { placeholder })`; the renderer gets the `ui`
subtree with the state. Dictionaries hold plain strings only: `{name}`
placeholders, and plurals as `{ one, other }` objects.

- New string: add the key to **every** dictionary.
- New language: add `src/i18n/xx.js` with the same keys as `en.js` and
  register it in `src/i18n/index.js`.
- The tests enforce it: same keys and same placeholders in every language,
  and no em dash.
- Texts sent to the agents (conversation context) stay in English.

## Continuous integration

Every PR runs:

| Check | Content |
| --- | --- |
| **Lint** | ESLint |
| **PR title** | Conventional Commits format |
| **Tests (ubuntu-latest)** | unit tests, end-to-end test |
| **Tests (windows-latest)** | unit tests, end-to-end test, installation |
| **CI** | summary of the checks above: this is the required check |
| **CodeQL** | code security analysis |

Screenshots from the end-to-end test can be downloaded from the
**Actions** tab, on each run. Dependabot opens dependency and action updates
every week (all pinned to a specific commit).

## Versions and releases

The project follows [semantic versioning](https://semver.org/). Before
1.0, a breaking change bumps the minor version.

Releases are automated by [release-please](https://github.com/googleapis/release-please):

1. On every merge to `main`, a "chore(main): release x.y.z" PR is created or
   updated, with the CHANGELOG and the version number in `package.json`.
2. When we want to publish, a maintainer merges that PR.
3. The `vX.Y.Z` tag and the GitHub release are created, with the source archive and
   its SHA-256 checksum.

`v*` tags are protected: only the automated release and administrators
can create them.

> **Release token (optional).** With the default GitHub Actions token,
> CI does not run on the release PR: only an administrator can then
> merge it. To have it tested like the others, create a fine-grained
> token (*Contents* and *Pull requests* write permissions on this
> repository) and save it as the `RELEASE_TOKEN` secret.

## Repository setup (maintainers)

`main` protection, squash merging, security alerts and
labels are configured once, with an administrator account:

```sh
gh auth login
./scripts/setup-github.sh --dry-run   # shows what will be done
./scripts/setup-github.sh
```

The protection rules are also in `.github/rulesets/`: they can be
imported by hand (Settings → Rules → Rulesets → Import a ruleset).

## Reporting a problem

- Bug or idea: open an issue with the matching template.
- Security flaw: **never in public**, see [SECURITY.md](SECURITY.md).

By contributing, you agree that your contribution is published under the
project's [MIT license](LICENSE), and you commit to following the
[code of conduct](CODE_OF_CONDUCT.md).

# Commit message

You write a commit message for the changes in the open repository.

- Read the staged changes (`git diff --cached`). If there are none, read the unstaged changes (`git diff`). If the user pastes a diff, use that one.
- Follow Conventional Commits: `type(scope): summary`, with `feat`, `fix`, `docs`, `refactor`, `test`, `chore`… Summary in the imperative, 72 characters at most.
- Add a short body that says why, not how, when the changes call for it.
- Answer with the message only, in a code block, ready to copy. Do not commit yourself.

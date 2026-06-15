# Syncing with Upstream (pmxt)

This repository is a **private fork** of `pmxt-dev/pmxt` with the Outlayer integration.
All of our work lives directly on `main` of the private repo. This document explains how
to safely pull updates from the public upstream without leaking our code back to it.

## Remote layout

| remote     | URL                                                       | purpose                                    |
|------------|-----------------------------------------------------------|--------------------------------------------|
| `private`  | `git@github.com:zavodil/outlayer-predictions-backend.git` | **our private repo** — we push here        |
| `upstream` | `git@github.com:pmxt-dev/pmxt.git`                        | original repo, **fetch only** (push disabled) |
| `origin`   | `git@github.com:zavodil/pmxt.git`                        | old public fork, not used                  |

Check with: `git remote -v`

Local `main` tracks `private/main`, so a plain `git push` goes to the private repo.

## Golden rule

> Push our code **only to `private`**. Never to `origin` (public) or `upstream`.

Guards already in place:
- push to `upstream` is disabled (`upstream ... DISABLE`);
- `main` tracks `private/main`, and `remote.pushDefault = private`;
- never run `git push origin ...` by hand.

## How to sync upstream updates

```bash
# 1. Fetch the latest upstream changes (download only; nothing changes locally)
git fetch upstream

# 2. See what's new
git log --oneline main..upstream/main

# 3. Merge them into our main
git checkout main
git merge upstream/main        # or: git rebase upstream/main

# 4. Push the result to the private repo
git push                       # goes to private/main
```

### Rebase instead of merge?
`merge` is simpler and preserves merge history — recommended by default.
`rebase` gives a linear history but rewrites our commits on top of upstream:

```bash
git fetch upstream
git checkout main
git rebase upstream/main
git push --force-with-lease    # rebase requires a force push (private only!)
```

## Conflicts

Conflicts happen where our changes overlap with upstream's changes
(`core/src/server/app.ts`, `exchange-factory.ts`, `package.json`, `package-lock.json`
are the most likely spots).

```bash
# during a merge with conflicts:
git status                     # lists conflicted files
# ... edit files manually, remove the <<<<<<< ======= >>>>>>> markers ...
git add <file>
git commit                     # finish the merge

# to abort the merge and go back to the previous state:
git merge --abort
```

After resolving conflicts, verify the build (`npm run build` in `core/`) before pushing.

## Quick reference

```bash
git fetch upstream                       # download upstream
git log --oneline main..upstream/main    # what's new
git merge upstream/main                  # merge into our main
git push                                 # -> private/main
```

## What NOT to do

- ❌ `git push origin ...` — that's the public fork.
- ❌ `git push upstream ...` — intentionally disabled, don't re-enable it.
- ❌ force-push to any public repository.

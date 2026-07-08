# Reviews follow your branch

Resolvr keys everything to your **git branch**: checking out `fix/auth-bug` starts (or resumes) the review session for that branch, diffed against the target branch — auto-detected `main`/`master`, or whatever you set.

```bash
git checkout -b my-feature
```

On the default branch you'll see working-tree changes only; the full review flow (diff tree, hunk navigation, verdicts) lights up on a feature branch.

Change the diff target any time with **Resolvr: Change Target Branch**, or set `resolvr.defaultTargetBranch` in settings.

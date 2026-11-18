# Rebase runbook

Rebase `disk` onto each new upstream release tag. Check for a new tag every 3 weeks.

The commands below call the upstream remote `upstream` (`rohitg00/agentmemory`) and the fork remote `fork` (`foreztgump/agentmemory`). Check the names with `git remote -v` first, and replace them if your checkout differs.

## 1. Prepare

1. Turn on conflict reuse, once per checkout:

   ```bash
   git config rerere.enabled true
   ```

2. Fetch, and pick the newest upstream release tag:

   ```bash
   git fetch upstream --tags
   git fetch fork
   git tag --list 'v*' --sort=-version:refname | grep -v -- '-am\.' | head -3
   ```

3. Record the start time, the old base tag and the new tag:

   ```bash
   OLD=v0.9.33   # the upstream tag disk is based on now
   NEW=v0.9.34   # the tag you are rebasing onto
   date -Iseconds
   ```

4. Make a backup branch:

   ```bash
   git switch disk
   git reset --hard fork/disk
   git branch disk-before-$NEW
   ```

## 2. Rebase

```bash
git rebase --onto "$NEW" "$OLD" disk
```

For each conflict:

1. Resolve it in the files git names. Keep upstream's change, and reapply the fork's change at the narrowest point that still works.
2. Build and run the tests for the files you touched before you continue.
3. Add one to the conflict count. Write down the commit and the files.
4. `git add` the files, then `git rebase --continue`.

If a fork commit is now in upstream, `git rebase --skip` drops it.

If the rebase goes wrong, `git rebase --abort`, or reset `disk` to `disk-before-$NEW` and start again.

## 3. Verify

Run the same checks as CI, then the fork's checks:

```bash
npm install --legacy-peer-deps --no-audit --no-fund
npm run build
npm run skills:check
npx tsc --noEmit --project tsconfig.eval.json
npm test
```

`npm test` includes the fork's tripwire tests, such as `test/fork-deploy-config.test.ts`. A failing tripwire means upstream changed something the fork depends on. Fix the fork's code. Do not change the tripwire to pass. Later fork work adds more tripwires; they run in the same suite.

## 4. Record

Add a row to the log below: the date, the old and new tags, the number of conflicts, the files, and the time from start to a passing `npm test`. The project measures rebase effort from this log.

## 5. Publish

1. Push `disk` to the fork. Use `--force-with-lease` so you cannot overwrite a push you have not seen:

   ```bash
   git push --force-with-lease=disk:fork/disk fork disk
   ```

2. Wait for CI on `disk` to pass.
3. Tag the release and push the tag. `N` starts at 1 on a new base:

   ```bash
   git tag -a "$NEW-am.1" -m "agentmemory fork on $NEW"
   git push fork "$NEW-am.1"
   ```

4. Update each stack's deploy branch from the tag, with `--force-with-lease`, one stack at a time. Coolify deploys the stack when its branch changes. Check its status page before you move to the next stack.
5. Delete `disk-before-$NEW` after the stacks have run for a day without problems.

Never push to upstream, and never rebase a deploy branch that production builds from without going through steps 1 to 4.

## Log

| Date | From | To | Conflicts | Files | Duration |
|---|---|---|---|---|---|

# Deployment

GitHub Actions publishes releases and PR canaries using OIDC, with Node.js 24 and npm 11.
Publishing does not require `NPM_TOKEN`.

Shared CI settings live in `.github/scripts/config.cjs`: Node/npm versions, the npm registry, publish access, tags
and prerelease cleanup rules. The package name comes from `package.json`. Workflows load these values through
`.github/actions/config`; triggers, permissions and job dependencies stay in the workflow files.

## One-time npm setup

In [npm package settings](https://www.npmjs.com/package/ai-release-notes/access), configure these GitHub Actions trusted publishers:

| Owner | Repository | Workflow filename | Environment |
| --- | --- | --- | --- |
| `tabkram` | `ai-release-notes` | `publish.yml` | Leave blank |
| `tabkram` | `ai-release-notes` | `pull-request.yml` | `canary` |

Enable **Allow npm publish** for each; leave **Allow npm dist-tag** disabled.
Each new connection must publish successfully within 48 hours or be recreated.
After that first success, there is no requirement to publish every 48 hours.
See [npm trusted publishing](https://docs.npmjs.com/trusted-publishers/) for details.

## Releases

1. Run **Release to NPM** on `main` with the desired version bump.
2. It checks the project, updates the version and changelog, and pushes a release commit.
3. Create and publish a GitHub Release with the matching tag, such as `v0.6.0`.
4. **Publish to NPM** checks out that tag, verifies its package version, runs lint/tests/build, and publishes.

Normal releases use `latest`; prereleases use `next`.
For an existing tag whose publication failed, first push the corrected workflow to `main`, then select
**Actions → Publish to NPM → Run workflow**, branch **main**, and enter the existing tag.
Rerunning the old failed job uses its old workflow. Already published npm versions cannot be overwritten.

## PR canaries

Add the `deploy` label to a PR targeting `main` to run CI and publish a canary, including when the label is added
after the initial checks. Eligible branch prefixes are `feat/`, `feature/`, `fix/`, `chore/` and `ci/`. Adding other labels
does not trigger the canary jobs. Subsequent commits and reopened PRs also publish when the label is present.
Only branches in this repository can publish; fork PRs still run CI. Canary publication uses the second trusted
publisher connection and the `canary` npm tag.

For a PR with `deploy`, successful CI is followed by **Deprecate previous canaries**, then **Publish canary**. Only that PR's
earlier canaries are deprecated, across base versions and dist-tags; the exact version planned for the new deployment
is excluded. Other PRs' canaries are untouched. If deprecation fails, Publish is skipped. The Publish job itself only publishes.

The separate **Deprecate** job deprecates all of a PR's canaries when it is closed, including after a merge,
independently of its branch name and labels. Automatic cleanup never deletes versions: deprecated versions remain downloadable
and display `Obsolete prerelease. Use ai-release-notes@latest for production.`
CI comments on the PR only for versions newly deprecated and verified during that run, with their npm links.

For manual deprecation, open **Actions → Deprecate from NPM → Run workflow** on `main`. Enter exact canary, dev,
alpha, beta or rc versions, comma-separated. Stable versions, tags and ranges are rejected. Already deprecated versions
are skipped, preserving their existing message and producing no comment. New deprecations are verified against fresh
registry metadata, allowing three checks two seconds apart. A zero exit code from npm alone is not sufficient; unresolved failures fail the job.

Deprecation requires `NPM_TOKEN` scoped to `ai-release-notes` with read/write access and **Bypass 2FA** enabled.
The action first checks authentication with `npm whoami`. When the token expires, replace it in
**Settings → Secrets and variables → Actions → NPM_TOKEN** in GitHub. Publishing continues to use OIDC separately.

## Delete a prerelease from GitHub Actions with browser 2FA

Once the workflow is merged to `main`:

1. Open **Actions → Unpublish from NPM with 2FA → Run workflow** and select `main`.
2. Enter exact prerelease versions, comma-separated, and type `I confirm to unpublish`.
3. Open the **Unpublish with browser 2FA** logs. Follow the npm login link, sign in as `tabkram`, then follow any
   additional authentication links to approve deletion with your npm 2FA method, such as Touch ID or a security key.
4. Check the job summary for verified removals. The job checks both registry metadata and archive availability.

Complete each authentication prompt within five minutes. Do not enter passwords, tokens or OTP codes in workflow
inputs. If npm asks you to type an OTP instead of opening a browser link, use the local procedure below.

The job uses a temporary npm session and attempts to revoke it on exit. Stable versions, tags and ranges are rejected;
the [npm unpublish policy](https://docs.npmjs.com/policies/unpublish/) still applies. Automatic PR cleanup only deprecates.

## Delete a prerelease locally with 2FA

npm rejects unpublish requests authenticated with a **Bypass 2FA** token. Use an interactive npm login and validate
the 2FA challenge instead. Deletion is still subject to the [npm unpublish policy](https://docs.npmjs.com/policies/unpublish/).

1. In a terminal, log in to the package owner's account and complete the browser authentication:

   ```bash
   npm login --registry=https://registry.npmjs.org/
   ```

2. Delete one exact prerelease version, replacing the example with the version you intend to remove. Complete the
   2FA challenge requested by npm. Run without `sudo`; `--dry-run=false` explicitly disables simulation.

   ```bash
   npm unpublish ai-release-notes@0.5.3-canary.12.abcdef0 --registry=https://registry.npmjs.org/ --dry-run=false --loglevel=http
   ```

3. Verify that the registry no longer serves that version:

   ```bash
   npm view ai-release-notes@0.5.3-canary.12.abcdef0 version --registry=https://registry.npmjs.org/ --prefer-online
   ```

   Expect `E404` once the removal has propagated. The `- ai-release-notes@...` output alone does not prove deletion;
   if the version remains available, inspect the unpublish HTTP logs. The npm website can take longer to update.

An unpublished version number cannot be reused. See the [registry authentication rules](https://api-docs.npmjs.com/)
and [npm unpublish reference](https://docs.npmjs.com/cli/v11/commands/npm-unpublish/).

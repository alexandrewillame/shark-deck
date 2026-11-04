# Releasing

Maintainer notes: what the GitHub workflows do, and how a release goes out.
Users never need any of this — it moved here from the README.

## What runs on its own

- **Every push** runs the tests on Windows, macOS and Linux
  (`.github/workflows/ci.yml`).
- **A push to `main`** also builds the installers for all three, downloadable
  for two weeks from the run's page under **Actions**
  (`.github/workflows/build.yml`).

## Releasing

Set the version in `app/package.json`, commit and push, then push a matching
tag:

```bash
git tag v0.1.0
git push origin v0.1.0
```

The tag builds all three platforms again and opens a **draft** release with
every installer attached. Nothing is public until you check the draft on the
repository's **Releases** page and press **Publish**.

Publishing the release also deploys the browser edition to GitHub Pages
(`.github/workflows/pages.yml`, after the tests pass). It can be redeployed by
hand from that workflow's page under **Actions** → **Run workflow** on `main`.

## One-time repository settings

Both were set on 2026-11-03; they are here in case they ever need redoing.

- **Settings → Pages → Build and deployment → Source: GitHub Actions.**
- **Settings → Environments → github-pages → Deployment branches and tags:**
  a tag rule `v*` next to `main`. By default the environment accepts only
  `main`, and a release builds from its tag.

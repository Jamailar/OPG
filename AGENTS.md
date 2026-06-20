# OPG System Agent Rules

## Release discipline

- Keep release bumps atomic. A version bump commit must only contain the version and lockfile changes for that released module.
- For Docker-backed releases, a pushed release tag is not complete until GitHub has a Release marked as latest.
- Every GitHub Release must include generated release notes or a manually written changelog that describes the changes since the previous relevant tag.
- Every Docker-backed GitHub Release must include downloadable single-image archives named `<image-name>-<version>.tar.gz`.
- Every uploaded image archive must include a matching `.sha256` checksum file.
- Use `.github/workflows/docker-release.yml` as the source of truth for Docker image publishing, release creation, latest promotion, and image archive assets.
- If a tag was pushed before the Release or image archive assets were created, rerun the Docker Release workflow with `workflow_dispatch` for that existing tag.

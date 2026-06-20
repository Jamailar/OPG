# OPG System Agent Rules

## Release discipline

- Keep release bumps atomic. A version bump commit must only contain the version and lockfile changes for that released module.
- For Docker-backed releases, a pushed release tag is not complete until GitHub has a Release marked as latest.
- Every GitHub Release must include a real changelog that lists changes since the previous relevant tag; source-code links alone are not enough.
- Every Docker-backed GitHub Release must include downloadable single-image archives named `<image-name>-<version>.tar.gz`.
- Every uploaded image archive must include a matching `.sha256` checksum file.
- Full `opg-system/vX.Y.Z` releases must also push the single-container `opg-system` image to Docker Hub and sync `README.md` to the Docker Hub repository description.
- Docker Hub repository descriptions should use `.github/dockerhub/README.md`, kept under Docker Hub's 25KB README limit.
- Docker Hub README content must not rely on relative HTML image paths. Use absolute public image URLs for `<img src="...">` assets that must render on Docker Hub.
- Do not promise automated Docker Hub per-repository avatar/logo updates; Docker Hub does not expose a stable normal repository avatar API. Use account/org branding or README imagery instead.
- Use `.github/workflows/docker-release.yml` as the source of truth for Docker image publishing, release creation, latest promotion, and image archive assets.
- If a tag was pushed before the Release or image archive assets were created, rerun the Docker Release workflow with `workflow_dispatch` for that existing tag.

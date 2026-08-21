# Clean Copy Notes

This folder is a cleaned source copy of the Portico application.

The original checkout was about 9.7 GB. This copy is about 114 MB because it excludes local/generated material such as:

- Git history (`.git`)
- installed dependencies (`node_modules`)
- Rust build outputs (`target`)
- generated frontend/debug builds (`dist`, `build`)
- local Open WebUI data and runtime snapshots
- test/cache/status artifacts
- local credential files such as `.env`, `.env.*`, `cloudsmith.env`, and `docker-compose.override.yml`

To work from this copy, reinstall dependencies and rebuild generated outputs using the repository's normal setup scripts.

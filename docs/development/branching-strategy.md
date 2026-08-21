# Branching strategy

Portico uses a two-stage integration flow:

```text
feature/* or fix/*  ->  develop  ->  main
```

- `main` is the protected release branch. It receives changes only through a
  pull request from `develop` after the required checks pass.
- `develop` is the protected integration branch. Feature and bug-fix branches
  target it through pull requests after the required checks pass.
- Pull requests do not require an approving review. The author remains able to
  merge once the checks are green, which keeps a small team moving while
  retaining an auditable review and test boundary.
- Direct pushes, force pushes, and branch deletion are blocked on both
  protected branches. Administrators are subject to the same rules.

Use short-lived branches with a clear prefix, such as `feature/mcp-catalog` or
`fix/oauth-callback-timeout`. Keep each pull request focused and let the
continuous-integration check complete before merging.

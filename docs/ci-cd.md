# CI/CD

The intended CI/CD model is:

- pull requests run repo checks
- safe autofixes can update the PR branch
- merges to `main` trigger a gateway deployment workflow
- the gateway workflow runs on a self-hosted runner on the gateway server

The repo includes starter GitHub Actions workflows under `.github/workflows/`
that align to the plan documents.


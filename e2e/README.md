# Wabizz E2E Tests (Playwright)

End-to-end tests covering the three critical user flows:

| Flow       | File                             | What it tests                             |
| ---------- | -------------------------------- | ----------------------------------------- |
| Auth       | `auth.setup.ts` + `auth.spec.ts` | Sign-up, sign-in, invalid login, sign-out |
| Onboarding | `onboarding.spec.ts`             | Business profile form submission          |
| Campaigns  | `campaigns.spec.ts`              | Create → list → launch a campaign         |

---

## Setup

```bash
# Install Playwright + browsers (one-time)
bunx playwright install --with-deps chromium
```

---

## Running tests

```bash
# All tests (headless)
bunx playwright test

# Interactive UI mode (best for development)
bunx playwright test --ui

# Watch a browser
bunx playwright test --headed

# Single file
bunx playwright test e2e/tests/campaigns.spec.ts

# Only Chromium (CI target)
bunx playwright test --project=chromium
```

---

## Environment variables

| Variable            | Default                 | Description             |
| ------------------- | ----------------------- | ----------------------- |
| `BASE_URL`          | `http://localhost:5173` | App URL to test against |
| `E2E_TEST_EMAIL`    | `e2e-test@wabizz.test`  | Test account email      |
| `E2E_TEST_PASSWORD` | `e2eTestPass123!`       | Test account password   |

For CI, set these in your GitHub Actions environment or repository secrets.

---

## CI integration

Add this job to `.github/workflows/ci-cd.yml` after the build job to run E2E on staging:

```yaml
e2e:
  name: E2E Tests (Playwright)
  runs-on: ubuntu-latest
  needs: [deploy-staging]
  if: github.ref == 'refs/heads/develop' && github.event_name == 'push'
  environment: staging
  steps:
    - uses: actions/checkout@v4
    - uses: oven-sh/setup-bun@v1
    - run: bun install --frozen-lockfile
    - run: bunx playwright install --with-deps chromium
    - run: bunx playwright test --project=chromium
      env:
        BASE_URL: ${{ vars.STAGING_APP_URL }}
        E2E_TEST_EMAIL: ${{ secrets.E2E_TEST_EMAIL }}
        E2E_TEST_PASSWORD: ${{ secrets.E2E_TEST_PASSWORD }}
    - uses: actions/upload-artifact@v4
      if: always()
      with:
        name: playwright-report
        path: playwright-report/
        retention-days: 14
```

---

## Auth state

`e2e/.auth/user.json` is created at runtime by `auth.setup.ts` and gitignored.
It contains browser cookies/localStorage for the test account. Do not commit it.

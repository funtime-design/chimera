# Setup screenshots

The pictures in the how-to guides (`docs/guides/<step>.md`). The setup page shows them inline, and the terminal prints their paths. Each file is named `<guide>-<N>.png` and is referenced right after the step it illustrates. A test checks that every guide's images exist.

Rules for every capture:

- PNG, cropped to the part of the page the step talks about, at least 640px wide (the page shows them at most 640px wide).
- Crop out or blank anything personal: the account name, email addresses, account IDs, team names and token values. Nothing else is needed to follow the step.
- Light or dark theme is fine. Do not draw arrows or other markup on it; the alt text says what to look for.

## Captured

| File | Page | Must be visible |
| --- | --- | --- |
| `master-token-1.png` | https://dash.cloudflare.com/profile/api-tokens | The page header and the Create Token button. |
| `master-token-2.png` | Create Token | The Create Custom Token row with Get started. |
| `master-token-3.png` | Create Custom Token | The token name, one permission row (Account, API Tokens, Edit) and Account Resources (Include, All accounts). |
| `master-token-4.png` | Create Custom Token, bottom | TTL with Select time range, and Continue to summary. |

## To capture

These slots hold a grey placeholder with the slot name until the real picture replaces it (same file name).

| File | Page | Must be visible | Crop out |
| --- | --- | --- | --- |
| `cloudflare-account-1.png` | https://dash.cloudflare.com/sign-up | The email and password fields and the Sign up button. | Anything typed into the fields. |
| `cloudflare-account-2.png` | After Sign up | The "verify your email" notice. | The email address. |
| `cloudflare-account-3.png` | Dashboard home | The account home page with the account menu at the top left. | The account name and email. |
| `wrangler-login-1.png` | The page `npx wrangler login` opens | "Allow Wrangler to make changes to your Cloudflare account?" and the Allow button. | The account name and email. |
| `wrangler-login-2.png` | The terminal after login | The last lines, ending with "Successfully logged in." | The email and the account name if printed. |
| `zero-trust-enable-1.png` | https://one.dash.cloudflare.com/ | The account picker. | Every account name. |
| `zero-trust-enable-2.png` | Zero Trust onboarding | The team name field and the Free plan. | The team name typed. |
| `zero-trust-enable-3.png` | Zero Trust overview | The overview page shown once Access is on. | The team name and account name. |

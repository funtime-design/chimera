# Sign up for Cloudflare

Why: the bridge runs on Cloudflare (a Worker), and the free plan is enough.

1. Open https://dash.cloudflare.com/sign-up.

   ![The Cloudflare sign-up form with the email and password fields.](../images/cloudflare-account-1.png)

2. Enter your email and a password, click Sign up, then open the email Cloudflare sends you and click its verify link.

   ![The "verify your email" notice Cloudflare shows after signing up.](../images/cloudflare-account-2.png)

3. When the dashboard asks what you want to do first, skip it: you land on the account home page, and the Free plan is already active.

   ![The Cloudflare dashboard home page with the account menu at the top left.](../images/cloudflare-account-3.png)

4. Back here, sign wrangler in to the new account: `npx wrangler login`.

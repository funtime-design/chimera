# Create the master token

Why: one token with only "API Tokens: Edit" lets `secrets:mint` make every other token, so you create one token by hand and paste it once.

1. Open https://dash.cloudflare.com/profile/api-tokens (Cloudflare dashboard > My Profile > API Tokens).

   ![The API Tokens page, with the blue Create Token button at the top right.](../images/master-token-1.png)

2. Click Create Token, then Create Custom Token > Get started.

   ![The Create API Token page, with Get started on the Create Custom Token row.](../images/master-token-2.png)

3. Give it a name, such as "chimera minter", and add one permission: Account / API Tokens / Edit. Nothing else. Under Account Resources, include your account (All accounts also works).

   ![The filled form: the token name, one permission row reading Account, API Tokens, Edit, and Account Resources set to Include, All accounts.](../images/master-token-3.png)

4. Under TTL, click Select time range and set the end date one year from today.

   ![The TTL section with the Select time range button, and Continue to summary at the bottom right.](../images/master-token-4.png)

5. Click Continue to summary, then Create Token.

6. Copy the token into your password manager now (Cloudflare shows it once), then run `pnpm secrets:mint -- --deployment <id>` in your own terminal and paste it at the hidden prompt.

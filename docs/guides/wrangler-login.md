# Log wrangler in to Cloudflare

Why: wrangler is Cloudflare's command-line tool; setup uses its login to find your account and domains, and to deploy.

1. In this folder, in your terminal, run `npx wrangler login`. It opens your browser.

2. In the browser, check the account is the one that should run the bridge, then click Allow.

   ![The Cloudflare page "Allow Wrangler to make changes to your Cloudflare account?" with the Allow button.](../images/wrangler-login-1.png)

3. Wait for the browser to say you can close the page, and for the terminal to print "Successfully logged in".

   ![The terminal after wrangler login, whose last line says it logged in successfully.](../images/wrangler-login-2.png)

4. Run the check again: the "Check again" button on the setup page, or `pnpm run setup -- --prereqs`.

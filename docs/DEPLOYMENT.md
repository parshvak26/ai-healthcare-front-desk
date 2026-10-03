# Demo website deployment

The current deployment target is a public portfolio demo, following the HVAC project pattern:

- GitHub Pages hosts the static Vite website.
- GitHub Actions builds and publishes the website from the main branch.
- The website stores sample changes in each visitor's browser.
- There is no live API, database, EHR, Retell calling, or SMS connection in this phase.

GitHub Pages on GitHub Free requires a public repository. Pages is appropriate here only as a portfolio/demo website with synthetic data; it is not the production host for a clinic service.

## Set up GitHub Pages

1. Create the public repository `ai-healthcare-front-desk` under the owner's GitHub account and push the main branch.
2. In the repository, open **Settings → Pages**.
3. Set the source to **GitHub Actions**.
4. Open **Actions** and run **Build and deploy demo website**, or push a later change to main.
5. GitHub will show the published project-page address on the Pages settings screen.

The workflow computes the repository base path automatically. It runs the production build before publishing and does not need API keys.

## Live integrations are not enabled

Do not add Retell, SMS, database, or storage credentials to the GitHub Pages workflow. The current site has no server-side API and cannot safely hold those credentials. A later phase will add a Cloudflare Worker and a separate database, then document their manual deployment separately. Live calls and texts will remain disabled until test-number allowlists and usage limits are configured.

## Production clinic use

This public demo is not a production healthcare service. Before using real clinic or patient information, replace the static-demo deployment with a separately reviewed production architecture, choose vendors and data region, and confirm applicable contracts and security controls.

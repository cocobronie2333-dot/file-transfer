# File Bridge

A browser-based large-file upload page, hosted on GitHub Pages.

Website: https://cocobronie2333-dot.github.io/file-transfer/

## Sign in

Enter the HTTPS URL of your receiving backend and its access key. Files are sent directly from your browser to that backend, not stored on GitHub. This repository contains the frontend only; a compatible receiving service must run separately.

- Up to 50 GB per file (50,000,000,000 bytes).
- Upload chunks no larger than 1 MB (1,000,000 bytes).
- Pause, resume, automatic retries, and per-chunk SHA-256 verification.
- Access-key login, per-tab session restoration, and logout.

The backend must allow this frontend origin:

```json
{
  "allowed_origins": ["https://cocobronie2333-dot.github.io"]
}
```

Use only the origin, without `/file-transfer/`. Actual API requests require the access key; CORS preflight requests must be handled before authentication. Allow GET, POST, PUT, DELETE and the Authorization, Content-Type, X-Chunk-SHA256 headers.

The Pages website uses HTTPS, so its receiving backend must also use HTTPS. Never commit access keys, backend config.json, or received files. The page remains public; API access is enforced by the receiving backend.

## Configure a default backend

Optionally edit `static/config.js`:

```javascript
globalThis.FILE_BRIDGE_CONFIG = Object.freeze({
  apiBase: 'https://your-receiving-backend.example.com'
});
```

Otherwise enter the backend address on the login page. Do not put an access key in this file. Existing sessions stay bound to their original backend until logout.

## Deployment

The workflow `.github/workflows/pages.yml` verifies the frontend and publishes only `static/` to GitHub Pages. In repository Settings > Pages, select GitHub Actions as the publishing source. Changes pushed to `main` under `static/` trigger deployment; it can also be run manually.

## Tests

Requires Node.js 20 or newer, with no extra npm dependencies:

```sh
node --check static/app.js
node tests/test_sha256.cjs
node tests/test_frontend.cjs
node tests/test_login.cjs
```

## Receiving backend

The default receiving URL is `https://file-transfer.tail65475f.ts.net`, provided by persistent Tailscale Funnel. The backend remains on the receiving computer. The owner must keep the computer online and preserve its Tailscale device and tailnet identity. Tailscale Funnel has provider bandwidth limits and is currently beta; the Personal plan is for non-commercial use. Backend authentication is still required, and access keys are never committed here.

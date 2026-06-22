# FreeLLMAPI (Fork)

This repository is a fork of the original [tashfeenahmed/freellmapi](https://github.com/tashfeenahmed/freellmapi) project, modified to remove premium gating and improve self-hosted model discovery.

> [!WARNING]
> This fork is fully AI-agent coded. Please use with caution. For stability and production-ready deployments, we recommend using the original upstream [main repository](https://github.com/tashfeenahmed/freellmapi).

## Key Modifications

* **Removed Premium Gatekeeping & Licensing**:
  * Deleted the Premium subscription validation, premium routing, licensing database settings, and the premium dashboard settings page. All capabilities are unlocked and completely free.
  * Dropped the legacy `catalog-sync` service that fetched static snapshots from the central server.
* **Dynamic Model Auto-Discovery**:
  * Replaced the central signed catalog sync with direct endpoint auto-discovery.
  * The server now queries configured provider endpoints (`/v1/models` or equivalent) at boot or on-demand to automatically detect, save, and enable new models.
  * Added global and per-provider **Discover** buttons to the dashboard's Keys page.
* **Simplified Custom Providers**:
  * You no longer need to type model IDs manually when adding a custom OpenAI-compatible endpoint. Simply specify the `base_url`, and the models will be automatically discovered.
* **Simplified Model Grouping**:
  * Added a `family` column in the database to group models automatically and simplify embeddings routing.

---

## Quick Start (Local Development)

**Prerequisites:** Node.js 20+, npm.

```bash
git clone https://github.com/Mohamed3nan/freellmapi.git
cd freellmapi
npm install
cp .env.example .env
# Generate an encryption key (required for at-rest storage)
node -e 'console.log(require("crypto").randomBytes(32).toString("hex"))'
# Paste the key as ENCRYPTION_KEY in your .env, then run:
npm run dev
```

Open [http://localhost:5173](http://localhost:5173) (Vite dev server) or [http://localhost:3001](http://localhost:3001) (API and production dashboard build) to add your API keys.

## Running with Docker Compose

**Prerequisites:** Docker, Docker Compose.

1. Generate an encryption key (used for encrypting stored API keys at rest):
   ```bash
   node -e 'console.log(require("crypto").randomBytes(32).toString("hex"))'
   ```
2. Create a `.env` file in the same directory:
   ```env
   ENCRYPTION_KEY=your_generated_key_here
   FREELLMAPI_CONTEXT_HANDOFF=on_model_switch
   REQUEST_ANALYTICS_RETENTION_DAYS=90
   REQUEST_ANALYTICS_MAX_ROWS=100000
   ```
3. Start the container:
   ```bash
   docker compose up -d
   ```

Open [http://localhost:3002](http://localhost:3002) to access the dashboard and API.

For detailed configuration, refer to the [original documentation](https://github.com/tashfeenahmed/freellmapi) or upstream repository.


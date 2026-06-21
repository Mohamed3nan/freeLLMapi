import { getDb, getSetting, setSetting } from '../db/index.js';
import { resolveProvider, getAllProviders } from '../providers/index.js';
import { decrypt } from '../lib/crypto.js';
import type { Platform, DiscoveryResult } from '@freellmapi/shared/types.js';

/**
 * model-discovery — auto-discover models from configured providers.
 *
 * Queries each provider's upstream model list endpoint (e.g. /v1/models) and
 * inserts any models not already in the local catalog. Discovered models are
 * added with conservative defaults and disabled by default — the user enables
 * them from the dashboard. Catalog-managed models (those already in the DB)
 * are never overwritten; discovery is strictly additive.
 *
 * Runs once at boot (after a delay for health checks) and on demand via the
 * dashboard's "Discover Models" button.
 */

const BOOT_DELAY_MS = 35_000; // 35s — after health check has time to validate keys
const SETTING_LAST_RUN = 'model_discovery_last_run_ms';
const SETTING_LAST_RESULTS = 'model_discovery_last_results';

/** Humanize a raw model ID into a display name. "meta-llama/llama-3.3-70b" → "Llama 3.3 70B" */
function humanizeModelId(modelId: string): string {
  // Strip publisher prefixes: "meta-llama/...", "openai/...", "@cf/meta/..."
  let name = modelId;
  const slashIdx = name.lastIndexOf('/');
  if (slashIdx >= 0) name = name.slice(slashIdx + 1);
  // Strip :free, :latest suffixes
  name = name.replace(/:(free|latest|experimental|preview)$/i, '');
  // Replace dashes/underscores with spaces
  name = name.replace(/[-_]/g, ' ');
  // Capitalize first letter of each word (but keep all-caps like "GPT" "AI")
  name = name.replace(/\b([a-z])/g, (_, c: string) => c.toUpperCase());
  return name.trim() || modelId;
}

/**
 * Discover models for a single platform. Uses the first enabled, healthy API key.
 * For custom providers, discovers from each endpoint separately and binds models
 * to their key_id.
 */
export async function discoverModelsForPlatform(platform: Platform): Promise<DiscoveryResult> {
  const result: DiscoveryResult = { platform, discovered: 0, inserted: 0, skipped: 0 };
  const db = getDb();

  try {
    if (platform === 'custom') {
      // Custom providers: each api_keys row is a separate endpoint; discover each independently.
      const customKeys = db.prepare(
        "SELECT id, encrypted_key, iv, auth_tag, base_url FROM api_keys WHERE platform = 'custom' AND enabled = 1",
      ).all() as { id: number; encrypted_key: string; iv: string; auth_tag: string; base_url: string | null }[];

      for (const keyRow of customKeys) {
        if (!keyRow.base_url) continue;
        const apiKey = decrypt(keyRow.encrypted_key, keyRow.iv, keyRow.auth_tag);
        const provider = resolveProvider('custom', keyRow.base_url);
        if (!provider) continue;

        const models = await provider.listModels(apiKey);
        result.discovered += models.length;

        for (const m of models) {
          const existing = db.prepare("SELECT id FROM models WHERE platform = 'custom' AND model_id = ?").get(m.id) as { id: number } | undefined;
          if (existing) {
            result.skipped++;
            continue;
          }

          // Insert discovered custom model bound to its endpoint key
          db.prepare(`
            INSERT OR IGNORE INTO models
              (platform, model_id, display_name, intelligence_rank, speed_rank, size_label,
               rpm_limit, rpd_limit, tpm_limit, tpd_limit, monthly_token_budget, context_window,
               enabled, supports_vision, supports_tools, key_id)
            VALUES ('custom', ?, ?, 50, 50, 'Unknown',
                    NULL, NULL, NULL, NULL, '', ?,
                    0, 0, 0, ?)
          `).run(m.id, m.name || humanizeModelId(m.id), m.context_window ?? null, keyRow.id);

          // Add to fallback chain (disabled)
          const modelRow = db.prepare("SELECT id FROM models WHERE platform = 'custom' AND model_id = ?").get(m.id) as { id: number } | undefined;
          if (modelRow) {
            const inChain = db.prepare('SELECT 1 FROM fallback_config WHERE model_db_id = ?').get(modelRow.id);
            if (!inChain) {
              const max = db.prepare('SELECT COALESCE(MAX(priority), 0) AS m FROM fallback_config').get() as { m: number };
              db.prepare('INSERT INTO fallback_config (model_db_id, priority, enabled) VALUES (?, ?, 0)').run(modelRow.id, max.m + 1);
            }
          }
          result.inserted++;
        }
      }
    } else {
      // Built-in providers: use the first enabled key
      const keyRow = db.prepare(
        'SELECT id, encrypted_key, iv, auth_tag, base_url FROM api_keys WHERE platform = ? AND enabled = 1 ORDER BY CASE status WHEN \'healthy\' THEN 0 WHEN \'unknown\' THEN 1 ELSE 2 END LIMIT 1',
      ).get(platform) as { id: number; encrypted_key: string; iv: string; auth_tag: string; base_url: string | null } | undefined;

      if (!keyRow) {
        return result; // No enabled key for this platform
      }

      const apiKey = decrypt(keyRow.encrypted_key, keyRow.iv, keyRow.auth_tag);
      const provider = resolveProvider(platform, keyRow.base_url);
      if (!provider) return result;

      const models = await provider.listModels(apiKey);
      result.discovered = models.length;

      const insertModel = db.prepare(`
        INSERT OR IGNORE INTO models
          (platform, model_id, display_name, intelligence_rank, speed_rank, size_label,
           rpm_limit, rpd_limit, tpm_limit, tpd_limit, monthly_token_budget, context_window,
           enabled, supports_vision, supports_tools)
        VALUES (?, ?, ?, 50, 50, 'Unknown',
                NULL, NULL, NULL, NULL, '', ?,
                0, 0, 0)
      `);

      for (const m of models) {
        // Skip models already in catalog — catalog metadata is authoritative
        const existing = db.prepare('SELECT id FROM models WHERE platform = ? AND model_id = ?').get(platform, m.id);
        if (existing) {
          result.skipped++;
          continue;
        }

        insertModel.run(platform, m.id, m.name || humanizeModelId(m.id), m.context_window ?? null);

        // Add to fallback chain (disabled) if not already present
        const modelRow = db.prepare('SELECT id FROM models WHERE platform = ? AND model_id = ?').get(platform, m.id) as { id: number } | undefined;
        if (modelRow) {
          const inChain = db.prepare('SELECT 1 FROM fallback_config WHERE model_db_id = ?').get(modelRow.id);
          if (!inChain) {
            const max = db.prepare('SELECT COALESCE(MAX(priority), 0) AS m FROM fallback_config').get() as { m: number };
            db.prepare('INSERT INTO fallback_config (model_db_id, priority, enabled) VALUES (?, ?, 0)').run(modelRow.id, max.m + 1);
          }
        }
        result.inserted++;
      }
    }
  } catch (err) {
    result.errors = err instanceof Error ? err.message : String(err);
    console.warn(`[model-discovery] Error discovering models for ${platform}: ${result.errors}`);
  }

  return result;
}

/**
 * Discover models for all platforms that have at least one enabled API key.
 */
export async function discoverAllModels(): Promise<DiscoveryResult[]> {
  const db = getDb();
  const platforms = db.prepare(
    'SELECT DISTINCT platform FROM api_keys WHERE enabled = 1',
  ).all() as { platform: string }[];

  const results: DiscoveryResult[] = [];

  for (const { platform } of platforms) {
    // Verify we have a registered provider for this platform
    const provider = resolveProvider(platform as Platform);
    if (!provider && platform !== 'custom') continue;

    const result = await discoverModelsForPlatform(platform as Platform);
    results.push(result);
  }

  // Store results
  setSetting(SETTING_LAST_RUN, String(Date.now()));
  setSetting(SETTING_LAST_RESULTS, JSON.stringify(results));

  return results;
}

/**
 * Get the last discovery run status.
 */
export function getDiscoveryStatus(): { lastRunMs: number | null; results: DiscoveryResult[] | null } {
  const lastRun = getSetting(SETTING_LAST_RUN);
  const resultsRaw = getSetting(SETTING_LAST_RESULTS);
  let results: DiscoveryResult[] | null = null;
  if (resultsRaw) {
    try { results = JSON.parse(resultsRaw) as DiscoveryResult[]; } catch { /* ignore */ }
  }
  return {
    lastRunMs: lastRun ? Number(lastRun) : null,
    results,
  };
}

let bootTimer: ReturnType<typeof setTimeout> | null = null;

/**
 * Schedule a one-time discovery run at boot, after health checks have had time
 * to validate keys. Only discovers from platforms with healthy/unknown keys.
 */
export function startModelDiscovery(): void {
  if (bootTimer) return;
  if (process.env.MODEL_DISCOVERY_DISABLED === '1') {
    console.log('[model-discovery] disabled via MODEL_DISCOVERY_DISABLED=1');
    return;
  }

  bootTimer = setTimeout(async () => {
    bootTimer = null;
    try {
      console.log('[model-discovery] Running boot-time model discovery...');
      const results = await discoverAllModels();
      const totalDiscovered = results.reduce((s, r) => s + r.discovered, 0);
      const totalInserted = results.reduce((s, r) => s + r.inserted, 0);
      const totalSkipped = results.reduce((s, r) => s + r.skipped, 0);
      const errors = results.filter(r => r.errors).length;
      console.log(
        `[model-discovery] Boot discovery complete: ${totalDiscovered} found, ${totalInserted} new, ${totalSkipped} existing` +
        (errors > 0 ? `, ${errors} platform(s) had errors` : ''),
      );
      // Log per-platform details for new models
      for (const r of results) {
        if (r.inserted > 0) {
          console.log(`[model-discovery]   ${r.platform}: +${r.inserted} new models`);
        }
      }
    } catch (err) {
      console.warn(`[model-discovery] Boot discovery failed: ${err instanceof Error ? err.message : err}`);
    }
  }, BOOT_DELAY_MS);
}

export function stopModelDiscovery(): void {
  if (bootTimer) {
    clearTimeout(bootTimer);
    bootTimer = null;
  }
}

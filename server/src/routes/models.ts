import { Router } from 'express';
import type { Request, Response } from 'express';
import { getDb } from '../db/index.js';
import { hasProvider } from '../providers/index.js';
import { deleteUnusedCustomEndpointKey } from '../lib/custom-provider-cleanup.js';
import { discoverAllModels, discoverModelsForPlatform, getDiscoveryStatus } from '../services/model-discovery.js';
import type { Platform } from '@freellmapi/shared/types.js';

export const modelsRouter = Router();

modelsRouter.delete('/custom/:id', (req: Request, res: Response) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) {
    res.status(400).json({ error: { message: 'Invalid id' } });
    return;
  }

  const db = getDb();
  const row = db.prepare("SELECT id, key_id FROM models WHERE id = ? AND platform = 'custom'").get(id) as { id: number; key_id: number | null } | undefined;
  if (!row) {
    res.status(404).json({ error: { message: `Unknown custom model ${id}` } });
    return;
  }

  const remove = db.transaction(() => {
    db.prepare('DELETE FROM fallback_config WHERE model_db_id = ?').run(id);
    db.prepare("DELETE FROM models WHERE id = ? AND platform = 'custom'").run(id);
    deleteUnusedCustomEndpointKey(db, row.key_id);
  });
  remove();
  res.json({ success: true });
});

// List all models with availability info
modelsRouter.get('/', (_req: Request, res: Response) => {
  const db = getDb();
  const models = db.prepare(`
    SELECT m.*, fc.priority, fc.enabled as fallback_enabled
    FROM models m
    LEFT JOIN fallback_config fc ON fc.model_db_id = m.id
    ORDER BY COALESCE(fc.priority, m.intelligence_rank) ASC
  `).all() as any[];

  // Count keys per platform
  const keyCounts = db.prepare(`
    SELECT platform, COUNT(*) as count
    FROM api_keys
    WHERE enabled = 1
    GROUP BY platform
  `).all() as { platform: string; count: number }[];

  const keyCountMap = new Map(keyCounts.map(k => [k.platform, k.count]));

  const result = models.map(m => ({
    id: m.id,
    platform: m.platform,
    modelId: m.model_id,
    displayName: m.display_name,
    intelligenceRank: m.intelligence_rank,
    speedRank: m.speed_rank,
    sizeLabel: m.size_label,
    rpmLimit: m.rpm_limit,
    rpdLimit: m.rpd_limit,
    tpmLimit: m.tpm_limit,
    tpdLimit: m.tpd_limit,
    monthlyTokenBudget: m.monthly_token_budget,
    contextWindow: m.context_window,
    enabled: m.enabled === 1,
    supportsVision: m.supports_vision === 1,
    supportsTools: m.supports_tools === 1,
    priority: m.priority,
    fallbackEnabled: m.fallback_enabled === 1,
    hasProvider: hasProvider(m.platform),
    keyCount: keyCountMap.get(m.platform) ?? 0,
  }));

  res.json(result);
});

// ── Model Auto-Discovery ────────────────────────────────────────────────────
// Discover models from all configured providers' upstream /v1/models endpoints.
modelsRouter.post('/discover', async (_req: Request, res: Response) => {
  try {
    const results = await discoverAllModels();
    res.json({ success: true, results });
  } catch (err) {
    res.status(500).json({ error: { message: err instanceof Error ? err.message : 'Discovery failed' } });
  }
});

// Discover models for a specific platform.
modelsRouter.post('/discover/:platform', async (req: Request, res: Response) => {
  const platform = req.params.platform as Platform;
  try {
    const result = await discoverModelsForPlatform(platform);
    res.json({ success: true, ...result });
  } catch (err) {
    res.status(500).json({ error: { message: err instanceof Error ? err.message : 'Discovery failed' } });
  }
});

// Get last discovery run status.
modelsRouter.get('/discovery-status', (_req: Request, res: Response) => {
  res.json(getDiscoveryStatus());
});


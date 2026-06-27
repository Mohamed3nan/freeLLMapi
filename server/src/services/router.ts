import { getDb, getSetting, setSetting } from '../db/index.js';
import { getProvider, hasProvider, resolveProvider } from '../providers/index.js';
import { decrypt } from '../lib/crypto.js';
import { canMakeRequest, canUseTokens, isOnCooldown, canUseProvider } from './ratelimit.js';
import { isUnifyEnabled, getModelGroups, resolveRequestedIdToMembers } from './model-groups.js';
import type { BaseProvider } from '../providers/base.js';
import type { Platform } from '@freellmapi/shared/types.js';
import type { Database } from 'better-sqlite3';

export function setRoutingStrategy(_strategy?: string): void {}
export function getRoutingStrategy(): string { return 'priority'; }
export function refreshStatsCache(_db?: any, _force?: boolean): void {}

export function getDefaultChatModel(): string {
  const setting = getSetting('chat_default_model');
  if (setting) return setting;
  const db = getDb();
  const withKey = db.prepare(`
    SELECT m.model_id
    FROM models m
    JOIN api_keys k ON k.platform = m.platform AND k.enabled = 1 AND k.status IN ('healthy', 'unknown')
    WHERE m.enabled = 1
    ORDER BY m.id ASC
    LIMIT 1
  `).get() as { model_id: string } | undefined;
  if (withKey) return withKey.model_id;

  const firstModel = db.prepare("SELECT model_id FROM models WHERE enabled = 1 ORDER BY id ASC LIMIT 1").get() as { model_id: string } | undefined;
  return firstModel?.model_id ?? 'gemini-1.5-flash';
}

export function setDefaultChatModel(modelId: string): void {
  setSetting('chat_default_model', modelId);
}

class RouteError extends Error {
  status: number;
  // Per-model disposition of the chain at the moment routing gave up: one line
  // per considered model with the reason it could not serve (no key, cooldown,
  // provider cap, rpm/rpd, tpm/tpd, context too small, …). Populated only on the
  // synchronous "all exhausted" throw, where NO upstream was tried and nothing
  // else logs WHY the pool was empty (issue _1: opaque routing_error 429).
  diagnostics?: string[];
  constructor(message: string, status: number, diagnostics?: string[]) {
    super(message);
    this.status = status;
    this.diagnostics = diagnostics;
  }
}

interface KeyRow {
  id: number;
  platform: string;
  encrypted_key: string;
  iv: string;
  auth_tag: string;
  status: string;
  enabled: number;
  base_url: string | null;
}

// Chain row joined with the model fields the bandit needs to score it.
export interface ChainRow {
  model_db_id: number;
  priority: number;
  enabled: number;
  platform: string;
  model_id: string;
  display_name: string;
  intelligence_rank: number;
  size_label: string;
  monthly_token_budget: string;
  rpm_limit: number | null;
  rpd_limit: number | null;
  tpm_limit: number | null;
  tpd_limit: number | null;
  supports_vision: number;
  supports_tools: number;
  context_window: number | null;
  // Custom models bind to the api_keys row carrying their endpoint (#212);
  // NULL for built-in platforms.
  key_id: number | null;
}

export interface RouteResult {
  provider: BaseProvider;
  modelId: string;
  modelDbId: number;
  apiKey: string;
  keyId: number;
  platform: string;
  displayName: string;
  // Daily limits for this model, so a 429 handler can tell a genuine daily
  // exhaustion (escalate the cooldown) from a transient per-minute spike.
  rpdLimit: number | null;
  tpdLimit: number | null;
}

// Round-robin index per platform
const roundRobinIndex = new Map<string, number>();

// ── Dynamic priority: track 429s per model and demote accordingly ──
// Key: model_db_id → { count, lastHit, penalty }
const rateLimitPenalties = new Map<number, { count: number; lastHit: number; penalty: number }>();

// Penalty decays over time so models recover
const PENALTY_PER_429 = 3;        // each 429 adds this many priority positions
const MAX_PENALTY = 10;            // cap so a model doesn't sink forever
const DECAY_INTERVAL_MS = 2 * 60 * 1000; // penalty decays every 2 minutes
const DECAY_AMOUNT = 1;            // remove this much penalty per decay interval

/**
 * Record a 429 for a model — increases its penalty so it sinks in priority.
 */
export function recordRateLimitHit(modelDbId: number) {
  const existing = rateLimitPenalties.get(modelDbId);
  const now = Date.now();
  if (existing) {
    const decaySteps = Math.floor((now - existing.lastHit) / DECAY_INTERVAL_MS);
    existing.penalty = Math.max(0, existing.penalty - decaySteps * DECAY_AMOUNT);
    existing.count++;
    existing.lastHit = now;
    existing.penalty = Math.min(existing.penalty + PENALTY_PER_429, MAX_PENALTY);
  } else {
    rateLimitPenalties.set(modelDbId, { count: 1, lastHit: now, penalty: PENALTY_PER_429 });
  }
}

/**
 * Record a success for a model — reduces its penalty so it rises back up.
 */
export function recordSuccess(modelDbId: number) {
  const existing = rateLimitPenalties.get(modelDbId);
  if (existing) {
    existing.penalty = Math.max(0, existing.penalty - 1);
    if (existing.penalty === 0) {
      rateLimitPenalties.delete(modelDbId);
    }
  }
}

/**
 * Get the current penalty for a model (with time-based decay).
 * Pure read — does not mutate the entry; decay is applied lazily only when
 * recording a new hit (recordRateLimitHit) so the clock isn't reset on every
 * routing call.
 */
function getPenalty(modelDbId: number): number {
  const entry = rateLimitPenalties.get(modelDbId);
  if (!entry) return 0;

  const elapsed = Date.now() - entry.lastHit;
  const decaySteps = Math.floor(elapsed / DECAY_INTERVAL_MS);
  const decayed = Math.max(0, entry.penalty - decaySteps * DECAY_AMOUNT);
  if (decayed === 0) {
    rateLimitPenalties.delete(modelDbId);
    return 0;
  }
  return decayed;
}

/**
 * Get current penalties for all models (for the API/dashboard).
 */
export function getAllPenalties(): Array<{ modelDbId: number; count: number; penalty: number }> {
  const result: Array<{ modelDbId: number; count: number; penalty: number }> = [];
  for (const [modelDbId, entry] of rateLimitPenalties) {
    const penalty = getPenalty(modelDbId);
    if (penalty > 0) {
      result.push({ modelDbId, count: entry.count, penalty });
    }
  }
  return result.sort((a, b) => b.penalty - a.penalty);
}

// ── Chain ordering ──────────────────────────────────────────────────────────
// Simple priority-based ordering: base priority + 429 penalty, ascending.
function orderChain(chain: ChainRow[]): ChainRow[] {
  return chain
    .map(e => ({ e, eff: e.priority + getPenalty(e.model_db_id) }))
    .sort((a, b) => a.eff - b.eff || a.e.priority - b.e.priority)
    .map(x => x.e);
}

function getModelCandidates(db: Database, targetModel: string, requireVision = false, requireTools = false): ChainRow[] {
  let modelToUse = targetModel;
  if (requireVision || requireTools) {
    const row = db.prepare(`SELECT supports_vision, supports_tools FROM models WHERE model_id = ?`).get(targetModel) as any;
    if (!row || (requireVision && !row.supports_vision) || (requireTools && !row.supports_tools)) {
      const fallback = db.prepare(`
        SELECT m.model_id FROM models m
        JOIN api_keys k ON k.platform = m.platform AND k.enabled = 1 AND k.status IN ('healthy', 'unknown')
        LEFT JOIN fallback_config fc ON fc.model_db_id = m.id
        WHERE m.enabled = 1 AND COALESCE(fc.enabled, 1) = 1
        ${requireVision ? 'AND m.supports_vision = 1' : ''}
        ${requireTools ? 'AND m.supports_tools = 1' : ''}
        ORDER BY COALESCE(fc.priority, 999) ASC, m.intelligence_rank ASC LIMIT 1
      `).get() as any;
      if (fallback) modelToUse = fallback.model_id;
    }
  }

  const members = isUnifyEnabled() ? resolveRequestedIdToMembers(modelToUse, getModelGroups()) : null;
  let chain: ChainRow[];
  if (members && members.length > 0) {
    chain = resolveModelGroupCandidates(members);
  } else {
    chain = db.prepare(`
      SELECT m.id as model_db_id, COALESCE(fc.priority, 0) as priority, COALESCE(fc.enabled, 1) as enabled,
             m.platform, m.model_id, m.display_name, m.intelligence_rank,
             m.size_label, m.monthly_token_budget,
             m.rpm_limit, m.rpd_limit, m.tpm_limit, m.tpd_limit, m.supports_vision,
             m.supports_tools, m.context_window, m.key_id
      FROM models m
      LEFT JOIN fallback_config fc ON fc.model_db_id = m.id
      WHERE m.model_id = ? AND m.enabled = 1
    `).all(modelToUse) as ChainRow[];
  }

  if (requireVision) chain = chain.filter(c => c.supports_vision === 1 || (c as any).supports_vision === true);
  if (requireTools) chain = chain.filter(c => c.supports_tools === 1 || (c as any).supports_tools === true);
  if (chain.length === 0 && (requireVision || requireTools)) {
    chain = db.prepare(`
      SELECT m.id as model_db_id, COALESCE(fc.priority, 0) as priority, COALESCE(fc.enabled, 1) as enabled,
             m.platform, m.model_id, m.display_name, m.intelligence_rank,
             m.size_label, m.monthly_token_budget,
             m.rpm_limit, m.rpd_limit, m.tpm_limit, m.tpd_limit, m.supports_vision,
             m.supports_tools, m.context_window, m.key_id
      FROM models m
      JOIN api_keys k ON k.platform = m.platform AND k.enabled = 1 AND k.status IN ('healthy', 'unknown')
      LEFT JOIN fallback_config fc ON fc.model_db_id = m.id
      WHERE m.enabled = 1 AND COALESCE(fc.enabled, 1) = 1
      ${requireVision ? 'AND m.supports_vision = 1' : ''}
      ${requireTools ? 'AND m.supports_tools = 1' : ''}
      ORDER BY COALESCE(fc.priority, 999) ASC, m.intelligence_rank ASC
    `).all() as ChainRow[];
  }
  return chain;
}

function getActiveChain(db: Database, requireVision = false, requireTools = false): ChainRow[] {
  const activeProfileSetting = db.prepare("SELECT value FROM settings WHERE key = 'active_profile_id'").get() as { value: string } | undefined;
  if (activeProfileSetting) {
    const profileId = parseInt(activeProfileSetting.value, 10);
    const chain = db.prepare(`
      SELECT pm.model_db_id, pm.priority, pm.enabled,
             m.platform, m.model_id, m.display_name, m.intelligence_rank,
             m.size_label, m.monthly_token_budget,
             m.rpm_limit, m.rpd_limit, m.tpm_limit, m.tpd_limit, m.supports_vision,
             m.supports_tools, m.context_window, m.key_id
      FROM profile_models pm
      JOIN models m ON m.id = pm.model_db_id AND m.enabled = 1
      WHERE pm.profile_id = ?
      ORDER BY pm.priority ASC
    `).all(profileId) as ChainRow[];
    
    if (chain.length > 0) return chain;
  }

  return getModelCandidates(db, getDefaultChatModel(), requireVision, requireTools);
}

function getChainByProfileName(db: Database, name: string): ChainRow[] | null {
  const profile = db.prepare("SELECT id FROM profiles WHERE LOWER(name) = ?").get(name.toLowerCase()) as { id: number } | undefined;
  if (!profile) return null;

  return db.prepare(`
    SELECT pm.model_db_id, pm.priority, pm.enabled,
           m.platform, m.model_id, m.display_name, m.intelligence_rank,
           m.size_label, m.monthly_token_budget,
           m.rpm_limit, m.rpd_limit, m.tpm_limit, m.tpd_limit, m.supports_vision,
           m.supports_tools, m.context_window, m.key_id
    FROM profile_models pm
    JOIN models m ON m.id = pm.model_db_id AND m.enabled = 1
    WHERE pm.profile_id = ?
    ORDER BY pm.priority ASC
  `).all(profile.id) as ChainRow[];
}

export function resolveRoutingChain(modelString: string | undefined): ResolvedChain {
  const db = getDb();

  if (!modelString || modelString.toLowerCase() === 'auto') {
    return { chain: getActiveChain(db), strategyKey: 'auto' };
  }

  const lower = modelString.toLowerCase();
  if (lower.startsWith('auto:')) {
    const suffix = lower.slice('auto:'.length).trim();
    if (suffix) {
      const chain = getChainByProfileName(db, suffix);
      if (chain && chain.length > 0) {
        const enabledModels = chain.filter(e => e.enabled);
        if (enabledModels.length > 0) {
          return { chain: enabledModels, strategyKey: `auto:${suffix}` };
        }
      }
    }
    return { chain: getActiveChain(db), strategyKey: 'auto' };
  }

  const candidateChain = getModelCandidates(db, modelString);
  if (candidateChain.length > 0) {
    return { chain: candidateChain, strategyKey: modelString };
  }

  return { chain: getActiveChain(db), strategyKey: 'auto' };
}

/**
 * Pick a usable key for ONE model and build its RouteResult, or return null if
 * the model has no key that can serve the request right now (all cooled down,
 * over quota, undecryptable, or no provider). This is the per-model key
 * round-robin previously inlined in routeRequest, factored out so the fusion
 * panel can HARD-PIN a model: rotate across that model's keys without ever
 * falling through to a different model (issue #326 — soft preference collapses
 * panel diversity under rate limits). Request-level filters (vision/tools/
 * context window) stay in the caller; this only does key selection + accounting
 * pre-checks.
 */
function selectKeyForModel(entry: ChainRow, estimatedTokens: number, skipKeys?: Set<string>, diag?: string[]): RouteResult | null {
  const db = getDb();
  const label = `${entry.platform}/${entry.model_id}`;

  if (!hasProvider(entry.platform as Platform)) {
    diag?.push(`${label}: no provider registered`);
    return null;
  }
  const provider = getProvider(entry.platform as Platform)!;

  const keys = db.prepare(
    "SELECT * FROM api_keys WHERE platform = ? AND enabled = 1 AND status IN ('healthy', 'unknown')"
  ).all(entry.platform) as KeyRow[];
  if (keys.length === 0) {
    diag?.push(`${label}: no enabled+healthy key for platform`);
    return null;
  }

  // Tally the gate that rejected each key, so the exhaustion diagnostic can say
  // *why* a model with keys still couldn't serve (all on cooldown vs over quota).
  const skipTally: Record<string, number> = {};
  const note = (reason: string) => { skipTally[reason] = (skipTally[reason] ?? 0) + 1; };

  const limits = {
    rpm: entry.rpm_limit,
    rpd: entry.rpd_limit,
    tpm: entry.tpm_limit,
    tpd: entry.tpd_limit,
  };

  const rrKey = `${entry.platform}:${entry.model_id}`;
  let idx = roundRobinIndex.get(rrKey) ?? 0;

  for (let attempt = 0; attempt < keys.length; attempt++) {
    const key = keys[idx % keys.length];
    idx++;

    // A custom model belongs to exactly one endpoint (#212); legacy rows
    // (key_id NULL) keep the old any-key match.
    if (entry.platform === 'custom' && entry.key_id != null && key.id !== entry.key_id) { note('custom-key-mismatch'); continue; }

    const skipId = `${entry.platform}:${entry.model_id}:${key.id}`;
    if (skipKeys?.has(skipId)) { note('already-failed-this-request'); continue; }

    if (isOnCooldown(entry.platform, entry.model_id, key.id)) { note('cooldown'); continue; }
    if (!canUseProvider(entry.platform, key.id)) { note('provider-daily-cap'); continue; }
    if (!canMakeRequest(entry.platform, entry.model_id, key.id, limits)) { note('rpm/rpd-limit'); continue; }
    if (!canUseTokens(entry.platform, entry.model_id, key.id, estimatedTokens, limits)) { note('tpm/tpd-limit'); continue; }

    let decryptedKey: string;
    try {
      decryptedKey = decrypt(key.encrypted_key, key.iv, key.auth_tag);
    } catch {
      db.prepare("UPDATE api_keys SET status = 'error', last_checked_at = datetime('now') WHERE id = ?")
        .run(key.id);
      note('decrypt-error');
      continue;
    }

    const resolvedProvider = entry.platform === 'custom'
      ? resolveProvider('custom', key.base_url)
      : provider;
    if (!resolvedProvider) { note('no-resolved-provider'); continue; }

    roundRobinIndex.set(rrKey, idx);
    return {
      provider: resolvedProvider,
      modelId: entry.model_id,
      modelDbId: entry.model_db_id,
      apiKey: decryptedKey,
      keyId: key.id,
      platform: entry.platform,
      displayName: entry.display_name,
      rpdLimit: limits.rpd,
      tpdLimit: limits.tpd,
    };
  }

  // No usable key for this model. Advance the round-robin index anyway so we
  // don't get stuck re-trying the same exhausted key first next time.
  roundRobinIndex.set(rrKey, idx);
  const summary = Object.entries(skipTally).map(([r, n]) => `${r}:${n}`).join(', ') || 'no usable key';
  diag?.push(`${label}: ${keys.length} key(s) — ${summary}`);
  return null;
}

/**
 * Fetch a single enabled model's chain row by its db id.
 */
function getModelChainRow(db: Database, modelDbId: number): ChainRow | undefined {
  return db.prepare(`
    SELECT m.id as model_db_id, 0 as priority, 1 as enabled,
           m.platform, m.model_id, m.display_name, m.intelligence_rank,
           m.size_label, m.monthly_token_budget,
           m.rpm_limit, m.rpd_limit, m.tpm_limit, m.tpd_limit, m.supports_vision,
           m.supports_tools, m.context_window, m.key_id
    FROM models m
    WHERE m.id = ? AND m.enabled = 1
  `).get(modelDbId) as ChainRow | undefined;
}

/**
 * Route to ONE specific model, hard-pinned. Rotates across that model's keys
 * (cooldowns, quotas, decryption all honored) but NEVER substitutes a different
 * model — returns null if the pinned model can't serve right now. This is what
 * makes a fusion panel genuinely diverse: a rate-limited slot is dropped, not
 * silently collapsed onto whatever else is available. `skipKeys` lets a slot
 * exclude keys it already failed on this request.
 */
export function routePinnedModel(modelDbId: number, estimatedTokens = 1000, skipKeys?: Set<string>): RouteResult | null {
  const db = getDb();
  const entry = getModelChainRow(db, modelDbId);
  if (!entry) return null;
  if (entry.context_window != null && estimatedTokens > entry.context_window) return null;
  if (entry.tpm_limit != null && estimatedTokens > entry.tpm_limit) return null;
  return selectKeyForModel(entry, estimatedTokens, skipKeys);
}

/**
 * Resolve a logical model group's member db ids to an ordered ChainRow[] for
 * strict group-pin routing (the "unify" feature). Each enabled member is
 * hydrated as a ChainRow carrying its REAL fallback_config.priority, then
 * ordered by the active strategy via orderChain — so 'priority' honors the
 * manual within-group order and scored strategies use live scores (priority as
 * the tiebreaker). Members disabled in the chain (fallback_config.enabled = 0)
 * are dropped.
 *
 * Pass the result to routeRequest() as `prefetchedChain` and DO NOT pass a
 * `preferredModelDbId` that isn't already one of these rows — otherwise the
 * preferred-model injection in routeRequest would unshift an off-group model and
 * the pin would no longer be strict (it could answer with a different model).
 */
export function resolveModelGroupCandidates(memberDbIds: number[]): ChainRow[] {
  const db = getDb();

  const selectMember = db.prepare(`
    SELECT m.id as model_db_id, COALESCE(fc.priority, 0) as priority,
           COALESCE(fc.enabled, 1) as enabled,
           m.platform, m.model_id, m.display_name, m.intelligence_rank,
           m.size_label, m.monthly_token_budget,
           m.rpm_limit, m.rpd_limit, m.tpm_limit, m.tpd_limit, m.supports_vision,
           m.supports_tools, m.context_window, m.key_id
    FROM models m
    LEFT JOIN fallback_config fc ON fc.model_db_id = m.id
    WHERE m.id = ? AND m.enabled = 1
  `);

  const rows: ChainRow[] = [];
  for (const id of memberDbIds) {
    const row = selectMember.get(id) as ChainRow | undefined;
    if (row && row.enabled) rows.push(row);
  }
  return orderChain(rows);
}

// A panel candidate surfaced to the fusion layer: enough to pick a diverse set
// and resolve each to a pinned dispatch.
export interface FusionCandidate {
  modelDbId: number;
  platform: string;
  modelId: string;
  displayName: string;
  sizeLabel: string;
  supportsVision: number;
  supportsTools: number;
}

/**
 * The active fallback chain ordered by the current routing strategy, surfaced
 * for fusion panel selection. Same ordering the normal auto-router would walk,
 * so the panel's auto-pick draws from the highest-scored models first and the
 * fusion layer just needs to apply provider-diversity on top.
 */
export function getOrderedFusionChain(): FusionCandidate[] {
  const db = getDb();
  const chain = getActiveChain(db).filter(e => e.enabled);

  const usableKeys = db.prepare(
    "SELECT id, platform FROM api_keys WHERE enabled = 1 AND status IN ('healthy', 'unknown')"
  ).all() as { id: number; platform: string }[];
  const keysByPlatform = new Map<string, number[]>();
  for (const k of usableKeys) {
    const arr = keysByPlatform.get(k.platform);
    if (arr) arr.push(k.id); else keysByPlatform.set(k.platform, [k.id]);
  }
  const servable = chain.filter(e => {
    const keyIds = keysByPlatform.get(e.platform);
    if (!keyIds) return false;
    const limits = { rpm: e.rpm_limit, rpd: e.rpd_limit, tpm: e.tpm_limit, tpd: e.tpd_limit };
    return keyIds.some(kid =>
      (e.key_id == null || kid === e.key_id) &&
      !isOnCooldown(e.platform, e.model_id, kid) &&
      canUseProvider(e.platform, kid) &&
      canMakeRequest(e.platform, e.model_id, kid, limits),
    );
  });

  const ordered = orderChain(servable);
  return ordered.map(e => ({
    modelDbId: e.model_db_id,
    platform: e.platform,
    modelId: e.model_id,
    displayName: e.display_name,
    sizeLabel: e.size_label,
    supportsVision: e.supports_vision,
    supportsTools: e.supports_tools,
  }));
}

/**
 * Resolve an explicit model id (as a client would type it) to a fusion
 * candidate, or null when it isn't a known enabled model. Prefers an enabled
 * row; dedupes a model id that exists on multiple platforms by intelligence
 * rank, matching how /v1/models picks a representative row.
 */
export function resolveFusionCandidate(modelId: string): FusionCandidate | null {
  const db = getDb();
  const row = db.prepare(`
    SELECT m.id as model_db_id, m.platform, m.model_id, m.display_name,
           m.size_label, m.supports_vision, m.supports_tools
    FROM models m
    WHERE m.model_id = ? AND m.enabled = 1
    ORDER BY m.intelligence_rank ASC, m.id ASC
    LIMIT 1
  `).get(modelId) as {
    model_db_id: number; platform: string; model_id: string; display_name: string;
    size_label: string; supports_vision: number; supports_tools: number;
  } | undefined;
  if (row) {
    return {
      modelDbId: row.model_db_id,
      platform: row.platform,
      modelId: row.model_id,
      displayName: row.display_name,
      sizeLabel: row.size_label,
      supportsVision: row.supports_vision,
      supportsTools: row.supports_tools,
    };
  }

  // Unify ON: a fusion picker value may be a canonical GROUP id rather than a
  // raw model_id. Resolve it to the group's best-ordered enabled member so
  // saved fusion configs that use canonical ids keep working. Exact model_id
  // match above always wins first, so OFF mode and legacy configs are untouched.
  if (isUnifyEnabled()) {
    const members = resolveRequestedIdToMembers(modelId, getModelGroups());
    if (members && members.length > 0) {
      const top = resolveModelGroupCandidates(members)[0];
      if (top) {
        return {
          modelDbId: top.model_db_id,
          platform: top.platform,
          modelId: top.model_id,
          displayName: top.display_name,
          sizeLabel: top.size_label,
          supportsVision: top.supports_vision,
          supportsTools: top.supports_tools,
        };
      }
    }
  }
  return null;
}

export function routeRequest(estimatedTokens = 1000, skipKeys?: Set<string>, preferredModelDbId?: number, requireVision = false, requireTools = false, skipModels?: Set<number>, prefetchedChain?: ChainRow[]): RouteResult {
  const db = getDb();

  const chain = prefetchedChain ?? getActiveChain(db, requireVision, requireTools).filter(e => e.enabled);

  const sortedChain = orderChain(chain);

  // Sticky session / Explicit pinning: move preferred model to front of chain
  if (preferredModelDbId) {
    const idx = sortedChain.findIndex(e => e.model_db_id === preferredModelDbId);
    if (idx >= 0) {
      if (idx > 0) {
        const [preferred] = sortedChain.splice(idx, 1);
        sortedChain.unshift(preferred);
      }
    } else {
      // The requested model is not in the current routing chain (e.g. it's a
      // custom model or not added to the active profile). We must fulfill the
      // explicit request by injecting it at the front.
      const pinnedRow = db.prepare(`
        SELECT m.id as model_db_id, 0 as priority, 1 as enabled,
               m.platform, m.model_id, m.display_name, m.intelligence_rank,
               m.size_label, m.monthly_token_budget,
               m.rpm_limit, m.rpd_limit, m.tpm_limit, m.tpd_limit, m.supports_vision,
               m.supports_tools, m.context_window, m.key_id
        FROM models m
        WHERE m.id = ? AND m.enabled = 1
      `).get(preferredModelDbId) as ChainRow | undefined;
      
      if (pinnedRow) {
        sortedChain.unshift(pinnedRow);
      }
    }
  }

  // Per-model disposition, attached to the exhaustion error when the loop falls
  // through with no route — the only record of WHY the pool was empty on the
  // synchronous "all exhausted" path (nothing downstream logs it). See issue _1.
  const diag: string[] = [];

  for (const entry of sortedChain) {
    const label = `${entry.platform}/${entry.model_id}`;
    // Models the caller has ruled out for this request — e.g. a 404
    // "model removed upstream" already seen this request: trying the same
    // model again on a different key would just burn another attempt on the
    // same dead route (PR #111, credits @barbotkonv).
    if (skipModels?.has(entry.model_db_id)) { diag.push(`${label}: ruled out earlier this request`); continue; }

    // Vision requests skip text-only models — including a sticky/preferred one,
    // which is correct: don't pin an image turn to a model that can't see it.
    if (requireVision && !entry.supports_vision) { diag.push(`${label}: no vision support`); continue; }

    // Tool-bearing requests skip models that can't emit structured tool_calls.
    // A model that "answers" a tool request with the call serialized as text
    // looks successful at the transport level while the client's harness sees
    // nothing — worse than a failover. Applies to sticky models too, same
    // reasoning as vision above.
    if (requireTools && !entry.supports_tools) { diag.push(`${label}: no tool-calling support`); continue; }

    // Context-aware routing: skip a model whose context window can't hold the
    // request, so a large prompt never selects a small-context model and burns
    // a failover hop on a 413 "request too large" (#167). Only enforced when we
    // know the model's window; estimatedTokens already includes the reserved
    // output (max_tokens), so this is the total-context check the model must
    // satisfy. A 413 that slips through is still retryable downstream, and the
    // failed model is put on cooldown — so this is a fast-path, not the only
    // guard. If every model is too small, the loop falls through and the caller
    // gets the normal "all models exhausted" error rather than a wasted sweep.
    if (entry.context_window != null && estimatedTokens > entry.context_window) { diag.push(`${label}: context ${entry.context_window} < estimated ${estimatedTokens}`); continue; }

    // Same guard for a model with a small per-minute token budget: a single
    // request that alone exceeds tpm_limit can never fit one minute of quota and
    // returns a guaranteed 413 (e.g. Groq gpt-oss-120b: 131k context but 8k TPM).
    // estimatedTokens already includes reserved output, mirroring the check above.
    if (entry.tpm_limit != null && estimatedTokens > entry.tpm_limit) { diag.push(`${label}: tpm_limit ${entry.tpm_limit} < estimated ${estimatedTokens}`); continue; }

    // Key selection + accounting pre-checks for this one model. Returns the
    // first usable key's RouteResult, or null when the model has no key that
    // can serve right now — in which case we fall through to the next model in
    // the sorted chain for THIS request (no explicit penalty needed).
    const route = selectKeyForModel(entry, estimatedTokens, skipKeys, diag);
    if (route) return route;
  }

  throw new RouteError('All models exhausted. Add more API keys or wait for rate limits to reset.', 429, diag);
}

/**
 * Per-model routing scores for the dashboard. Deterministic (expected
 * reliability, not sampled) so the table is stable between polls. Returns the
 * axis breakdown plus the final score under the active strategy's weights.
 */
export interface RoutingScore {
  modelDbId: number;
  platform: string;
  modelId: string;
  displayName: string;
  enabled: boolean;
  score: number;
}

export function getRoutingScores(): { strategy: string; weights: null; customWeights: null; scores: RoutingScore[] } {
  const db = getDb();
  const chain = getActiveChain(db);
  const scores: RoutingScore[] = chain.map(entry => ({
    modelDbId: entry.model_db_id,
    platform: entry.platform,
    modelId: entry.model_id,
    displayName: entry.display_name,
    enabled: entry.enabled === 1,
    score: 1.0,
  }));
  return { strategy: 'priority', weights: null, customWeights: null, scores };
}

// Whether at least one vision-capable model is enabled in the fallback chain.
// Used to give image requests a clear "enable a vision model" error instead of
// the generic exhaustion message when none is configured (#118, #125).
export function hasEnabledVisionModel(): boolean {
  const db = getDb();
  const row = db.prepare(`
    SELECT COUNT(*) as cnt
    FROM fallback_config fc
    JOIN models m ON m.id = fc.model_db_id
    WHERE fc.enabled = 1 AND m.enabled = 1 AND m.supports_vision = 1
  `).get() as { cnt: number };
  return row.cnt > 0;
}

// Whether at least one tool-capable model is enabled in the fallback chain.
// Same role as hasEnabledVisionModel: a clear up-front error for tool-bearing
// requests beats routing them to a model that mangles the tool call.
export function hasEnabledToolsModel(): boolean {
  const db = getDb();
  const row = db.prepare(`
    SELECT COUNT(*) as cnt
    FROM fallback_config fc
    JOIN models m ON m.id = fc.model_db_id
    WHERE fc.enabled = 1 AND m.enabled = 1 AND m.supports_tools = 1
  `).get() as { cnt: number };
  return row.cnt > 0;
}

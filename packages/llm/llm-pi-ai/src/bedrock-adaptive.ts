/** Process-local recovered budgets, isolated by the resolved route configuration and model. */
import type { ResolvedBedrockConfig } from './bedrock-config.ts'

/** Effective limits for a Failsafe generation. */
export interface BedrockBudget {
  /** Conservative serialized request budget in UTF-8 bytes. */
  requestBytes: number
  /** Output token ceiling. */
  outputTokens: number
}

interface LearnedBudget extends BedrockBudget { expiresAt: number }

/** Configuration identity invalidates learning; expiry permits later recalibration without sharing process-global state. */
export class BedrockAdaptiveBudgets {
  private readonly routes = new WeakMap<ResolvedBedrockConfig, Map<string, LearnedBudget>>()

  /**
   * Resolve a detached budget for one configured route and model.
   * @param policy - resolved route identity and hard ceilings.
   * @param model - model id within that route.
   * @returns learned limits, or configured limits when absent or expired.
   */
  read(policy: ResolvedBedrockConfig, model: string): BedrockBudget {
    const models = this.routes.get(policy)
    const saved = models?.get(model)
    if (saved !== undefined && saved.expiresAt > Date.now()) {
      return { requestBytes: saved.requestBytes, outputTokens: saved.outputTokens }
    }
    models?.delete(model)
    return { requestBytes: policy.maxRequestBytes, outputTokens: policy.maxOutputTokens }
  }

  /**
   * Publish successful recovery without letting a concurrent, larger recovery erase a smaller one.
   * @param policy - route identity and retention policy.
   * @param model - model id within that route.
   * @param recovered - limits that completed an attempt after a corrective reduction.
   */
  remember(policy: ResolvedBedrockConfig, model: string, recovered: BedrockBudget): void {
    const current = this.read(policy, model)
    let models = this.routes.get(policy)
    if (models === undefined) this.routes.set(policy, models = new Map<string, LearnedBudget>())
    models.set(model, {
      requestBytes: Math.min(current.requestBytes, recovered.requestBytes),
      outputTokens: Math.min(current.outputTokens, recovered.outputTokens),
      expiresAt: Date.now() + policy.adaptiveTtlMs,
    })
  }
}

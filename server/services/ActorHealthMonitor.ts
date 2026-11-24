/**
 * Actor Health Monitor
 * Monitors the health and availability of external actors (Apify, APIs)
 */

import { logger } from '../utils/logger.js';
import { ACTOR_HEALTH_CHECK_INTERVAL_MS, ACTOR_HEALTH_CHECK_TIMEOUT_MS } from '../utils/timingConstants';

export interface ActorHealthStatus {
  actorId: string;
  status: 'healthy' | 'degraded' | 'unhealthy';
  lastChecked: Date;
  responseTime?: number;
  errorMessage?: string;
  consecutiveFailures: number;
  totalRequests: number;
  successRate: number;
}

export interface HealthCheckResult {
  actorId: string;
  healthy: boolean;
  responseTime: number;
  error?: string;
}

export class ActorHealthMonitor {
  private healthStatus: Map<string, ActorHealthStatus> = new Map();
  private healthCheckInterval: number = ACTOR_HEALTH_CHECK_INTERVAL_MS;
  private maxConsecutiveFailures: number = 3;
  private healthCheckTimeout: number = ACTOR_HEALTH_CHECK_TIMEOUT_MS;
  private checkTimer: ReturnType<typeof setInterval> | null = null;
  private destroyed = false;

  constructor() {
    // Start periodic health checks
    this.checkTimer = setInterval(() => this.performHealthChecks(), this.healthCheckInterval);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    if (this.checkTimer && typeof (this.checkTimer as any).unref === 'function') {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (this.checkTimer as any).unref();
    }
  }

  /**
   * Phase 4.13 / DEPLOY-005: clear the periodic health-check timer and reset
   * the in-memory status map. Safe to call multiple times.
   */
  public destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    if (this.checkTimer) {
      clearInterval(this.checkTimer);
      this.checkTimer = null;
    }
    this.healthStatus.clear();
  }

  /**
   * Phase 4.13: convenience dispose helper for the singleton. Mirrors
   * `dispose()` in similar services so callers don't need to know about
   * the class internals.
   */
  public dispose(): void {
    this.destroy();
  }

  /**
   * Record a successful actor call
   */
  recordSuccess(actorId: string, responseTime: number): void {
    const status = this.getOrCreateStatus(actorId);
    status.totalRequests++;
    status.lastChecked = new Date();
    status.responseTime = responseTime;
    status.consecutiveFailures = 0;
    status.errorMessage = undefined;
    status.successRate = (status.totalRequests - status.consecutiveFailures) / status.totalRequests;

    this.updateHealthStatus(status);
  }

  /**
   * Record a failed actor call
   */
  recordFailure(actorId: string, error: string): void {
    const status = this.getOrCreateStatus(actorId);
    status.totalRequests++;
    status.consecutiveFailures++;
    status.lastChecked = new Date();
    status.errorMessage = error;
    status.successRate = (status.totalRequests - status.consecutiveFailures) / status.totalRequests;

    this.updateHealthStatus(status);
  }

  /**
   * Check if an actor is healthy
   */
  isHealthy(actorId: string): boolean {
    const status = this.healthStatus.get(actorId);
    if (!status) return true; // Assume healthy if never tested

    return status.status === 'healthy';
  }

  /**
   * Get health status for an actor
   */
  getHealthStatus(actorId: string): ActorHealthStatus | null {
    return this.healthStatus.get(actorId) || null;
  }

  /**
   * Get all health statuses
   */
  getAllHealthStatuses(): ActorHealthStatus[] {
    return Array.from(this.healthStatus.values());
  }

  /**
   * Perform health checks for all monitored actors
   */
  private async performHealthChecks(): Promise<void> {
    const actorsToCheck = Array.from(this.healthStatus.keys());

    logger.info(`[ActorHealthMonitor] Performing health checks for ${actorsToCheck.length} actors`);

    for (const actorId of actorsToCheck) {
      try {
        const result = await this.checkActorHealth(actorId);

        if (result.healthy) {
          this.recordSuccess(actorId, result.responseTime);
          logger.info(`[ActorHealthMonitor] ✅ ${actorId} is healthy (${result.responseTime}ms)`);
        } else {
          this.recordFailure(actorId, result.error || 'Health check failed');
          logger.info(`[ActorHealthMonitor] ❌ ${actorId} is unhealthy: ${result.error}`);
        }
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } catch (error: any) {
        this.recordFailure(actorId, error.message);
        logger.info(`[ActorHealthMonitor] ❌ ${actorId} health check error: ${error.message}`);
      }
    }
  }

  /**
   * Check health of a specific actor
   */
  private async checkActorHealth(actorId: string): Promise<HealthCheckResult> {
    const startTime = Date.now();

    try {
      // For Apify actors, we do a lightweight check
      if (actorId.startsWith('apify/')) {
        // Import dynamically to avoid circular dependencies
        const { ApifyService } = await import('./agents/ApifyService.js');
        // Use admin credentials for health checks
        const apifyService = await ApifyService.createWithAdminCredentials();

        // Try to get actor info (lightweight operation)
        await apifyService.getActorInfo(actorId.replace('apify/', ''));

        const responseTime = Date.now() - startTime;
        return {
          actorId,
          healthy: true,
          responseTime,
        };
      }

      // For other actors, implement specific health checks
      // For now, assume healthy
      const responseTime = Date.now() - startTime;
      return {
        actorId,
        healthy: true,
        responseTime,
      };

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } catch (error: any) {
      const responseTime = Date.now() - startTime;
      return {
        actorId,
        healthy: false,
        responseTime,
        error: error.message,
      };
    }
  }

  /**
   * Get or create health status for an actor
   */
  private getOrCreateStatus(actorId: string): ActorHealthStatus {
    let status = this.healthStatus.get(actorId);
    if (!status) {
      status = {
        actorId,
        status: 'healthy',
        lastChecked: new Date(),
        consecutiveFailures: 0,
        totalRequests: 0,
        successRate: 1.0,
      };
      this.healthStatus.set(actorId, status);
    }
    return status;
  }

  /**
   * Update the health status based on current metrics
   */
  private updateHealthStatus(status: ActorHealthStatus): void {
    if (status.consecutiveFailures >= this.maxConsecutiveFailures) {
      status.status = 'unhealthy';
    } else if (status.successRate < 0.8) {
      status.status = 'degraded';
    } else {
      status.status = 'healthy';
    }

    this.healthStatus.set(status.actorId, status);
  }

  /**
   * Get health summary for monitoring
   */
  getHealthSummary(): {
    totalActors: number;
    healthyActors: number;
    degradedActors: number;
    unhealthyActors: number;
  } {
    const statuses = Array.from(this.healthStatus.values());
    const healthy = statuses.filter(s => s.status === 'healthy').length;
    const degraded = statuses.filter(s => s.status === 'degraded').length;
    const unhealthy = statuses.filter(s => s.status === 'unhealthy').length;

    return {
      totalActors: statuses.length,
      healthyActors: healthy,
      degradedActors: degraded,
      unhealthyActors: unhealthy,
    };
  }
}

// Singleton instance
export const actorHealthMonitor = new ActorHealthMonitor();
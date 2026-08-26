import type { CryptoBotPrincipal } from "../../mcp/auth.ts";
import type {
  AlgoBotStatus,
  BybitBotsOutput,
  ControlCenterBootstrap,
  DashboardOverview,
  DecisionExplanation,
  PortfolioOutput,
  RiskStatus,
  SystemHealth,
} from "./domain.ts";
import type { CryptoBotRepository, RepoResult, Row } from "./repository.ts";
import { createScopedSupabase } from "./supabase.ts";
import { createSupabaseRepository } from "./supabase-repository.ts";
import { mapAlgoBotStatus } from "./gateway/algobot.ts";
import { mapBybitBots } from "./gateway/bybit-bots.ts";
import { explainPersistedDecision } from "./gateway/decision.ts";
import { mapDashboardOverview } from "./gateway/overview.ts";
import { mapPortfolio } from "./gateway/portfolio.ts";
import { mapRiskStatus } from "./gateway/risk.ts";
import { mapSystemHealth } from "./gateway/system-health.ts";

function failed<T>(result: RepoResult<T>): boolean {
  return Boolean(result.error);
}

export type CryptoBotGateway = {
  getDashboardOverview(): Promise<DashboardOverview>;
  getAlgoBotStatus(): Promise<AlgoBotStatus>;
  getBybitBots(): Promise<BybitBotsOutput>;
  getPortfolio(): Promise<PortfolioOutput>;
  getRiskStatus(): Promise<RiskStatus>;
  getSystemHealth(): Promise<SystemHealth>;
  explainDecision(decisionId: string): Promise<DecisionExplanation>;
  getControlCenterBootstrap(): Promise<ControlCenterBootstrap>;
};

export function createCryptoBotGateway(
  principal: CryptoBotPrincipal,
  repository: CryptoBotRepository = createSupabaseRepository(createScopedSupabase(principal)),
  now: () => number = Date.now,
): CryptoBotGateway {
  const userId = principal.supabaseUserId;

  async function loadAlgo(): Promise<AlgoBotStatus> {
    const [performance, decisions, bots] = await Promise.all([
      repository.getStrategyPerformance(userId),
      repository.getStrategyDecisions(userId, 50),
      repository.getBotStatuses(userId),
    ]);
    return mapAlgoBotStatus(
      performance.data,
      decisions.data,
      bots.data,
      [performance, decisions, bots].some(failed),
      now(),
    );
  }

  async function loadBybitBots(): Promise<BybitBotsOutput> {
    const snapshot = await repository.getLiveSnapshot(userId);
    return mapBybitBots(snapshot.data, now());
  }

  async function loadPortfolio(): Promise<PortfolioOutput> {
    const [snapshot, assets, positions, executions] = await Promise.all([
      repository.getLiveSnapshot(userId),
      repository.getAccountAssets(userId),
      repository.getOpenPositions(userId),
      repository.getExecutions(userId),
    ]);
    return mapPortfolio(
      snapshot.data,
      assets.data,
      positions.data,
      executions.data,
      [snapshot, assets, positions, executions].some(failed),
      now(),
    );
  }

  async function loadRisk(): Promise<RiskStatus> {
    const [dashboard, bots, riskEvents] = await Promise.all([
      repository.getDashboardSummary(userId),
      repository.getBotStatuses(userId),
      repository.getRiskEvents(userId, 20),
    ]);
    return mapRiskStatus(
      dashboard.data,
      bots.data,
      riskEvents.data,
      [dashboard, bots, riskEvents].some(failed),
      now(),
    );
  }

  async function loadSystem(): Promise<SystemHealth> {
    const [snapshot, connection, bots, stream, orderbook] = await Promise.all([
      repository.getLiveSnapshot(userId),
      repository.getExchangeConnection(userId),
      repository.getBotStatuses(userId),
      repository.getStreamState(userId),
      repository.getOrderbookStreamState(userId),
    ]);
    return mapSystemHealth(
      snapshot.data,
      connection.data,
      bots.data,
      stream.data,
      orderbook.data,
      {
        exchange: failed(snapshot) || failed(connection),
        engine: failed(bots),
        stream: failed(stream),
        orderbook: failed(orderbook),
      },
      now(),
    );
  }

  async function loadOverview(): Promise<DashboardOverview> {
    const [dashboard, snapshot, algobot, bybitBots, risk, system] = await Promise.all([
      repository.getDashboardSummary(userId),
      repository.getLiveSnapshot(userId),
      loadAlgo(),
      loadBybitBots(),
      loadRisk(),
      loadSystem(),
    ]);
    return mapDashboardOverview(dashboard.data, snapshot.data, algobot, bybitBots, risk, system);
  }

  return {
    getDashboardOverview: loadOverview,
    getAlgoBotStatus: loadAlgo,
    getBybitBots: loadBybitBots,
    getPortfolio: loadPortfolio,
    getRiskStatus: loadRisk,
    getSystemHealth: loadSystem,
    async explainDecision(decisionId) {
      if (!/^\d+$/.test(decisionId)) throw new Error("invalid_decision_id");
      const result = await repository.getStrategyDecision(userId, decisionId);
      if (result.error) throw new Error(result.error === "invalid_decision_id" ? result.error : "decision_source_unavailable");
      if (!result.data) throw new Error("decision_not_found");
      return explainPersistedDecision(result.data, now());
    },
    async getControlCenterBootstrap() {
      const [overview, algobot, bybitBots, portfolio, risk, system] = await Promise.all([
        loadOverview(),
        loadAlgo(),
        loadBybitBots(),
        loadPortfolio(),
        loadRisk(),
        loadSystem(),
      ]);
      return { overview, algobot, bybit_bots: bybitBots, portfolio, risk, system };
    },
  };
}

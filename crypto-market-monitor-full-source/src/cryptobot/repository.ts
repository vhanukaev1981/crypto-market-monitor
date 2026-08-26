export type Row = Record<string, unknown>;

export type RepoResult<T> = {
  data: T;
  error: string | null;
};

export interface CryptoBotRepository {
  getLiveSnapshot(userId: string): Promise<RepoResult<Row | null>>;
  getDashboardSummary(userId: string): Promise<RepoResult<Row | null>>;
  getAccountAssets(userId: string): Promise<RepoResult<Row[]>>;
  getOpenPositions(userId: string): Promise<RepoResult<Row[]>>;
  getExecutions(userId: string): Promise<RepoResult<Row[]>>;
  getBotStatuses(userId: string): Promise<RepoResult<Row[]>>;
  getStrategyPerformance(userId: string): Promise<RepoResult<Row[]>>;
  getStrategyDecisions(userId: string, limit?: number): Promise<RepoResult<Row[]>>;
  getRiskEvents(userId: string, limit?: number): Promise<RepoResult<Row[]>>;
  getExchangeConnection(userId: string): Promise<RepoResult<Row | null>>;
  getStreamState(userId: string): Promise<RepoResult<Row | null>>;
  getOrderbookStreamState(userId: string): Promise<RepoResult<Row | null>>;
}

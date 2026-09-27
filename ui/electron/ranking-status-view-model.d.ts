export type RankingStatusViewModel = Readonly<{
  schema: string;
  active_stat_date: string | null;
  active_snapshot_id: string | null;
  active_core_id: string | null;
  active_recipe_id: string | null;
  source_freshness: unknown;
  active_status: string;
  update_task_status: string | null;
  update_task_phase: string | null;
  update_task_busy: boolean;
  last_success_at: string | null;
  error: string | null;
  active_error: string | null;
}>;
export function buildRankingStatusViewModel(input?: {
  rankingsStatus?: object | null;
  updateTask?: object | null;
}): RankingStatusViewModel;

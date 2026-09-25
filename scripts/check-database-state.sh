#!/usr/bin/env bash
# デプロイ時に「DBの状態」だけを検証する。**書き込みを一切行わない**。
#
# 背景(改善台帳P0-74): 以前はデプロイのたびに`npm run db:verify`を本番DATABASE_URLで
# 実行していた。db:verifyは migration 0001〜0007 と seeds/demo.sql を適用するため、
# 毎デプロイで次が本番DBへ書き込まれていた。
#   - seeds/demo.sql の投入(デモ案件・デモ図面・デモ監査行)
#   - 0004 が dwg_demo_001 の name を上書きし visibility='public' を強制
#   - 0006 が監査の追記専用トリガを drop → audit_logs を UPDATE → 再作成
#   - 検証probe行の INSERT(ROLLBACKされるが、トランザクション内では書き込みが発生する)
# 本スクリプトは読取りと「ROLLBACKする検査トランザクション」だけで、期待するスキーマが
# 揃っているかを判定する。migrationの適用は行わないため、migrationを含むリリースでは
# デプロイ前に明示的に `npm run db:verify` を実行する必要がある(揃っていなければ本
# スクリプトが失敗し、デプロイは中止される)。
set -euo pipefail

if [[ -z "${DATABASE_URL:-}" ]]; then
  echo "DATABASE_URL is required" >&2
  exit 2
fi

# 本スクリプトが適用後状態を検証しているmigrationの一覧。migrations/に一覧外のファイルがあれば失敗する。
# 新しいmigrationを追加するときは、その適用後状態(テーブル・列・制約・索引等)の検査を下へ追加し、
# ここへファイル名を登録すること(tests/deploy-script.test.jsがCIでも同じ整合を検査する)。
covered_migrations=(
  0001_initial.sql
  0002_idempotency.sql
  0003_drawing_revision.sql
  0004_drawing_visibility.sql
  0005_audit_log_immutability.sql
  0006_normalize_jsonb_columns.sql
  0007_project_membership.sql
  0008_audit_truncate_guard.sql
)
migrations_dir="$(dirname "$0")/../migrations"
uncovered=""
for file in "$migrations_dir"/*.sql; do
  name="$(basename "$file")"
  [[ " ${covered_migrations[*]} " == *" ${name} "* ]] || uncovered="${uncovered} ${name}"
done
if [[ -n "$uncovered" ]]; then
  echo "database state check failed: db:checkが適用後状態を検証していないmigrationがあります:${uncovered}" >&2
  echo "  → scripts/check-database-state.sh へ検査を追加し covered_migrations へ登録してください。" >&2
  exit 1
fi

# migration 0001〜0007 が作るテーブル。欠落は「migration未適用」を意味する。
expected_tables=(agent_runs audit_logs command_events drawing_versions drawings idempotency_keys project_members projects reviews)
# migration 0003/0004/0007 が追加する列。
expected_columns=("drawings:revision" "drawings:visibility" "projects:access_scope")
# migration 0001/0004/0007 のCHECK制約と、0001/0002/0007 の索引。
expected_constraints=(drawings_state_check drawing_versions_state_check command_events_source_check agent_runs_status_check reviews_status_check drawings_visibility_check projects_access_scope_check)
expected_indexes=(idx_drawings_project_id idx_versions_drawing_id idx_command_events_version_id idx_agent_runs_version_id idx_audit_logs_target idx_idempotency_keys_created_at idx_project_members_member)

missing_tables=""
for table in "${expected_tables[@]}"; do
  present="$(psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -Atc "select to_regclass('public.${table}') is not null")"
  [[ "$present" == "t" ]] || missing_tables="${missing_tables} ${table}"
done

missing_columns=""
for entry in "${expected_columns[@]}"; do
  table="${entry%%:*}"
  column="${entry##*:}"
  present="$(psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -Atc "
    select count(*) from information_schema.columns
    where table_schema = 'public' and table_name = '${table}' and column_name = '${column}'
  ")"
  [[ "$present" == "1" ]] || missing_columns="${missing_columns} ${table}.${column}"
done

missing_constraints=""
for constraint in "${expected_constraints[@]}"; do
  present="$(psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -Atc "
    select count(*) from pg_constraint c join pg_namespace n on n.oid = c.connamespace
    where n.nspname = 'public' and c.conname = '${constraint}'
  ")"
  [[ "$present" == "1" ]] || missing_constraints="${missing_constraints} ${constraint}"
done

missing_indexes=""
for index in "${expected_indexes[@]}"; do
  present="$(psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -Atc "select to_regclass('public.${index}') is not null")"
  [[ "$present" == "t" ]] || missing_indexes="${missing_indexes} ${index}"
done

if [[ -n "$missing_tables" || -n "$missing_columns" || -n "$missing_constraints" || -n "$missing_indexes" ]]; then
  echo "database state check failed: migrationが未適用です。" >&2
  [[ -n "$missing_tables" ]] && echo "  欠落テーブル:${missing_tables}" >&2
  [[ -n "$missing_columns" ]] && echo "  欠落列:${missing_columns}" >&2
  [[ -n "$missing_constraints" ]] && echo "  欠落制約:${missing_constraints}" >&2
  [[ -n "$missing_indexes" ]] && echo "  欠落索引:${missing_indexes}" >&2
  echo "  → docs/deployment-local.md「Migrationを含むリリース」に従い、該当migrationを適用してください。" >&2
  echo "     (本番DBへdb:verifyを実行しないこと。seeds/demo.sqlも適用され、デモ行の投入や既存行の上書きが起きます)" >&2
  exit 1
fi

# 監査ログの追記専用保護(0005)が実際に効いていることを確認する。検査はROLLBACKする。
trigger_count="$(psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -Atc "
  select count(*) from pg_trigger
  where tgrelid = 'audit_logs'::regclass and not tgisinternal and tgname like 'audit_logs_no_%'
")"
if [[ "$trigger_count" != "3" ]]; then
  echo "database state check failed: 監査ログの追記専用トリガが3件ではありません(found=${trigger_count}, expected=3)。" >&2
  echo "  → docs/deployment-local.md「Migrationを含むリリース」に従い、migration 0005/0006/0008を適用してください。" >&2
  exit 1
fi

# UPDATE/DELETE/TRUNCATEの拒否をerrcode 42501とメッセージ本文まで確認する(検査はROLLBACK)。
if ! psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f scripts/sql/verify-audit-append-only.sql >/dev/null; then
  echo "database state check failed: 監査ログの追記専用保護が機能していません。" >&2
  exit 1
fi

# 残余リスクの可視化(失敗ではない): 接続ロールがaudit_logsの所有者だと、
# トリガでは防げないDDL(`alter table ... disable trigger` / `drop trigger`)を実行できる。
# 所有権分離は環境固有の運用操作のため、ここでは警告に留める。
audit_owner="$(psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -Atc "select pg_get_userbyid(relowner) from pg_class where oid = 'audit_logs'::regclass")"
current_role="$(psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -Atc "select current_user")"
if [[ "$audit_owner" == "$current_role" ]]; then
  echo "警告: audit_logsの所有者が接続ロール(${current_role})と同一です。TRIGGERはUPDATE/DELETE/TRUNCATEを拒否しますが、DDL(disable trigger/drop trigger)は防げません。scripts/sql/harden-audit-role.sql による所有権分離を検討してください。" >&2
fi

# migration 0006 が正規化したはずのJSONB string scalarが残っていないこと(読取りのみ)。
json_string_count="$(psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -Atc "
  select
    (select count(*) from drawing_versions where jsonb_typeof(content) = 'string') +
    (select count(*) from command_events where jsonb_typeof(command_payload) = 'string') +
    (select count(*) from agent_runs where jsonb_typeof(proposal) = 'string') +
    (select count(*) from audit_logs where jsonb_typeof(detail) = 'string')
")"
if [[ "$json_string_count" != "0" ]]; then
  echo "database state check failed: JSONB string scalarsが残っています(found=${json_string_count})。" >&2
  exit 1
fi

echo "database state check ok: migrations=${#covered_migrations[@]} tables=${#expected_tables[@]} constraints=${#expected_constraints[@]} indexes=${#expected_indexes[@]} audit_triggers=${trigger_count} jsonb_strings=0"

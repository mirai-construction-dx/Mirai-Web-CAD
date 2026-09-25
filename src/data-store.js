import postgres from "postgres";
import { seedDrawing } from "./cad-core.js";

export const LEGACY_PROJECT_ID = "prj_demo_road_001";

const memory = {
  drawings: new Map(),
  drawingProjects: new Map(),
  projects: new Map(),
  projectMembers: new Map(),
  agentRuns: new Map(),
  auditLogs: [],
  idempotencyKeys: new Set()
};

// connectionString単位でプールをメモ化する。createDataStore(env)はAPIリクエスト毎に
// 呼ばれるため、メモ化しないとリクエスト毎に新規TCPプールが生成され、
// このホストを共有する他プロジェクトを巻き込む接続枯渇を招く。
const pools = new Map();

function getPool(connectionString, poolMax) {
  let sql = pools.get(connectionString);
  if (!sql) {
    sql = postgres(connectionString, {
      max: poolMax,
      idle_timeout: 30,
      connect_timeout: 10,
      onnotice: () => {}
    });
    pools.set(connectionString, sql);
  }
  return sql;
}

export function createDataStore(env = {}) {
  if (env.DATA_STORE) return env.DATA_STORE;
  const connectionString = env.DATABASE_URL;
  if (connectionString) {
    const poolMax = Number.isFinite(Number(env.PG_POOL_MAX)) && env.PG_POOL_MAX ? Number(env.PG_POOL_MAX) : 8;
    return new PostgresDataStore(getPool(connectionString, poolMax));
  }
  return new MemoryDataStore();
}

// serve-production.mjsのSIGTERMハンドラから呼び、コネクションプールを
// graceful に閉じる。テストやローカルdemoモードでは呼ばれないため無害。
export async function closeDataStorePool() {
  const instances = [...pools.values()];
  pools.clear();
  await Promise.allSettled(instances.map((sql) => sql.end({ timeout: 5 })));
}

export function resetMemoryStoreData() {
  memory.drawings.clear();
  memory.drawingProjects.clear();
  memory.projects.clear();
  memory.projectMembers.clear();
  memory.agentRuns.clear();
  memory.auditLogs.splice(0, memory.auditLogs.length);
  memory.idempotencyKeys.clear();
  ensureMemorySeed();
}

class MemoryDataStore {
  constructor() {
    ensureMemorySeed();
  }

  async probe() {
    return { provider: "memory", mode: "memory-preview", migration: "0007_project_membership.sql" };
  }

  async getDrawing(id) {
    return clone(memory.drawings.get(id));
  }

  async getPublicDrawing(id) {
    return id === "dwg_demo_001" ? clone(memory.drawings.get(id)) : null;
  }

  async getDrawingProjectId(id) {
    if (!memory.drawings.has(id)) return null;
    return memory.drawingProjects.get(id) ?? LEGACY_PROJECT_ID;
  }

  async getProject(id) {
    return clone(memory.projects.get(id)) ?? null;
  }

  async createProject(project) {
    if (memory.projects.has(project.id)) return null;
    const stored = clone({
      id: project.id,
      name: project.name,
      owner: project.owner,
      status: "active",
      accessScope: project.accessScope
    });
    memory.projects.set(project.id, stored);
    memory.projectMembers.set(project.id, new Set());
    return clone(stored);
  }

  async updateProjectAccessScope(id, accessScope) {
    const project = memory.projects.get(id);
    if (!project) return null;
    project.accessScope = accessScope;
    return clone(project);
  }

  async listProjectMembers(projectId) {
    return [...(memory.projectMembers.get(projectId) ?? [])].sort();
  }

  async isProjectMember(projectId, member) {
    return memory.projectMembers.get(projectId)?.has(member.toLowerCase()) ?? false;
  }

  async addProjectMember(projectId, member) {
    if (!memory.projectMembers.has(projectId)) memory.projectMembers.set(projectId, new Set());
    memory.projectMembers.get(projectId).add(member.toLowerCase());
  }

  async removeProjectMember(projectId, member) {
    memory.projectMembers.get(projectId)?.delete(member.toLowerCase());
  }

  async saveDrawing(drawing) {
    const current = memory.drawings.get(drawing.id);
    if (current && drawing.revision !== current.revision + 1) {
      throw conflictError(current.revision, drawing.revision - 1);
    }
    memory.drawings.set(drawing.id, clone(drawing));
    return drawing;
  }

  async createDrawingAtomically(drawing, auditEntry, idempotencyKey, _actorId, _route, projectId = LEGACY_PROJECT_ID) {
    if (memory.idempotencyKeys.has(idempotencyKey) || memory.drawings.has(drawing.id)) return false;
    const storedDrawing = clone(drawing);
    const storedAudit = clone(auditEntry);
    memory.drawings.set(drawing.id, storedDrawing);
    memory.drawingProjects.set(drawing.id, projectId);
    memory.auditLogs.push(storedAudit);
    memory.idempotencyKeys.add(idempotencyKey);
    return true;
  }

  async saveDrawingAtomically(drawing, auditEntry, idempotencyKey, _actorId, _route, agentRun = null) {
    const current = memory.drawings.get(drawing.id);
    if (memory.idempotencyKeys.has(idempotencyKey)) return false;
    if (!current || drawing.revision !== current.revision + 1) {
      throw conflictError(current?.revision ?? null, drawing.revision - 1);
    }
    if (agentRun && !memory.agentRuns.has(agentRun.id)) {
      throw Object.assign(new Error(`Agent Runが見つかりません: ${agentRun.id}`), { status: 404 });
    }
    if (agentRun && memory.agentRuns.get(agentRun.id).status !== "planned") {
      throw agentRunConflictError(agentRun.id);
    }
    memory.drawings.set(drawing.id, clone(drawing));
    memory.auditLogs.push(clone(auditEntry));
    memory.idempotencyKeys.add(idempotencyKey);
    if (agentRun) memory.agentRuns.set(agentRun.id, clone(agentRun));
    return true;
  }

  async saveAgentRun(run) {
    memory.agentRuns.set(run.id, clone(run));
    return run;
  }

  async getAgentRun(id) {
    return clone(memory.agentRuns.get(id));
  }

  async appendAudit(entry) {
    // 監査行は「必ず1行記録される」ことを要求する。黙って落ちると承認判断の根拠が
    // 欠けたことに誰も気づけないため、重複IDは異常として扱う。
    if (memory.auditLogs.some((item) => item.id === entry.id)) {
      throw new Error(`監査ログを記録できませんでした(重複ID): ${entry.id}`);
    }
    memory.auditLogs.push(clone(entry));
  }

  async listAuditLogs(limit = 100, offset = 0) {
    const ordered = memory.auditLogs.slice().reverse();
    return ordered.slice(offset, offset + limit).map(clone);
  }

  async countAuditLogs() {
    return memory.auditLogs.length;
  }

  async claimIdempotency(key) {
    if (memory.idempotencyKeys.has(key)) return false;
    memory.idempotencyKeys.add(key);
    return true;
  }

  async releaseIdempotency(key) {
    memory.idempotencyKeys.delete(key);
  }

  async hasIdempotency(key) {
    return memory.idempotencyKeys.has(key);
  }
}

class PostgresDataStore {
  constructor(sql) {
    this.sql = sql;
  }

  async probe() {
    const rows = await this.sql`
      select current_database() as database,
             exists (
               select 1 from information_schema.tables
               where table_schema = 'public' and table_name = 'drawing_versions'
             ) and exists (
               select 1 from information_schema.tables
               where table_schema = 'public' and table_name = 'idempotency_keys'
             ) and exists (
               select 1 from information_schema.columns
               where table_schema = 'public' and table_name = 'drawings' and column_name = 'revision'
             ) and exists (
               select 1 from information_schema.columns
               where table_schema = 'public' and table_name = 'drawings' and column_name = 'visibility'
             ) and exists (
               select 1 from information_schema.triggers
               where event_object_table = 'audit_logs' and trigger_name = 'audit_logs_no_update'
             ) and exists (
               select 1 from information_schema.triggers
               where event_object_table = 'audit_logs' and trigger_name = 'audit_logs_no_delete'
             ) and exists (
               select 1 from information_schema.columns
               where table_schema = 'public' and table_name = 'projects' and column_name = 'access_scope'
             ) and exists (
               select 1 from information_schema.tables
               where table_schema = 'public' and table_name = 'project_members'
             ) and not exists (
               select 1 from drawing_versions where jsonb_typeof(content) = 'string'
             ) and not exists (
               select 1 from command_events where jsonb_typeof(command_payload) = 'string'
             ) and not exists (
               select 1 from agent_runs where jsonb_typeof(proposal) = 'string'
             ) and not exists (
               select 1 from audit_logs where jsonb_typeof(detail) = 'string'
             ) as migrated
    `;
    return {
      provider: "postgres",
      mode: "connected",
      database: rows[0].database,
      migrated: rows[0].migrated,
      migration: "0007_project_membership.sql"
    };
  }

  async getDrawing(id, publicOnly = false) {
    const rows = await this.sql`
      select d.id, d.name, d.unit, d.current_version, d.revision, d.state, v.content
      from drawings d
      join drawing_versions v
        on v.drawing_id = d.id and v.version_no = d.current_version
      where d.id = ${id}
        and (${publicOnly} = false or d.visibility = 'public')
      limit 1
    `;
    if (rows.length === 0) return null;

    const row = rows[0];
    const drawing = parseStoredJson(row.content);
    // 保存済みcontentがCAD図面として解釈できない場合、以前はデモ図面を黙って返していた。
    // その挙動は「利用者に誤った図面を見せ、そのまま保存させると同一版を上書きして実データを
    // 失う」ため、fail-closedで明示的に失敗させる(呼び出し元は500として扱い、内部詳細は返さない)。
    if (!isCadDrawing(drawing)) {
      throw new Error(`保存済み図面contentが解釈できません: ${row.id} (version ${row.current_version})`);
    }
    return {
      ...drawing,
      schemaVersion: 1,
      id: row.id,
      name: row.name,
      unit: row.unit,
      version: row.current_version,
      state: row.state,
      revision: Number(row.revision)
    };
  }

  async getPublicDrawing(id) {
    return this.getDrawing(id, true);
  }

  async getDrawingProjectId(id) {
    const rows = await this.sql`select project_id from drawings where id = ${id} limit 1`;
    return rows.length === 0 ? null : rows[0].project_id;
  }

  async getProject(id) {
    const rows = await this.sql`
      select id, name, owner, status, access_scope
      from projects
      where id = ${id}
      limit 1
    `;
    if (rows.length === 0) return null;
    const row = rows[0];
    return { id: row.id, name: row.name, owner: row.owner, status: row.status, accessScope: row.access_scope };
  }

  async createProject(project) {
    const rows = await this.sql`
      insert into projects (id, name, owner, status, access_scope)
      values (${project.id}, ${project.name}, ${project.owner}, 'active', ${project.accessScope})
      on conflict (id) do nothing
      returning id, name, owner, status, access_scope
    `;
    if (rows.length === 0) return null;
    const row = rows[0];
    return { id: row.id, name: row.name, owner: row.owner, status: row.status, accessScope: row.access_scope };
  }

  async updateProjectAccessScope(id, accessScope) {
    const rows = await this.sql`
      update projects set access_scope = ${accessScope}, updated_at = now()
      where id = ${id}
      returning id, name, owner, status, access_scope
    `;
    if (rows.length === 0) return null;
    const row = rows[0];
    return { id: row.id, name: row.name, owner: row.owner, status: row.status, accessScope: row.access_scope };
  }

  async listProjectMembers(projectId) {
    const rows = await this.sql`
      select member from project_members where project_id = ${projectId} order by member
    `;
    return rows.map((row) => row.member);
  }

  async isProjectMember(projectId, member) {
    const rows = await this.sql`
      select 1 from project_members where project_id = ${projectId} and member = ${member.toLowerCase()} limit 1
    `;
    return rows.length === 1;
  }

  async addProjectMember(projectId, member, addedBy) {
    await this.sql`
      insert into project_members (project_id, member, added_by)
      values (${projectId}, ${member.toLowerCase()}, ${addedBy})
      on conflict (project_id, member) do nothing
    `;
  }

  async removeProjectMember(projectId, member) {
    await this.sql`
      delete from project_members where project_id = ${projectId} and member = ${member.toLowerCase()}
    `;
  }

  // 注意: 現行のアプリケーション経路は saveDrawingAtomically を使用しており、この
  // メソッドは未使用(レガシー)である。かつて project_id を 'prj_demo_road_001' に
  // 固定していたため、将来ここを呼ぶと図面がデモ案件へ混入し、案件単位のアクセス
  // 制御(requireProjectAccess)が意図しない判定になる。呼び出し側が明示した
  // projectId を優先し、無い場合のみレガシー既定値へフォールバックする。
  async saveDrawing(drawing) {
    const projectId = typeof drawing.projectId === "string" && drawing.projectId ? drawing.projectId : LEGACY_PROJECT_ID;
    const content = this.sql.json(drawing);
    const contentHash = drawing.commandEvents?.at(-1)?.afterHash ?? `version-${drawing.version}`;
    const versionId = `ver_${drawing.id}_${String(drawing.version).padStart(3, "0")}`;
    const actor = drawing.auditLog?.at(-1)?.actor ?? drawing.currentRole ?? "system";
    const expectedRevision = drawing.revision - 1;
    const rows = await this.sql`
      with drawing_write as (
        insert into drawings (id, project_id, name, unit, current_version, revision, state)
        values (
          ${drawing.id}, ${projectId}, ${drawing.name}, ${drawing.unit},
          ${drawing.version}, ${drawing.revision}, ${drawing.state}
        )
        on conflict (id) do update set
          name = excluded.name,
          unit = excluded.unit,
          current_version = excluded.current_version,
          revision = excluded.revision,
          state = excluded.state,
          updated_at = now()
        where drawings.revision = ${expectedRevision}
        returning id
      ), version_write as (
        insert into drawing_versions (id, drawing_id, version_no, state, content, content_hash, created_by)
        select ${versionId}, ${drawing.id}, ${drawing.version}, ${drawing.state},
               ${content}, ${contentHash}, ${actor}
        from drawing_write
        on conflict (drawing_id, version_no) do update set
          state = excluded.state,
          content = excluded.content,
          content_hash = excluded.content_hash
        returning drawing_id
      )
      select drawing_id from version_write
    `;
    if (rows.length === 0) throw conflictError(null, expectedRevision);
    return drawing;
  }

  async createDrawingAtomically(drawing, auditEntry, idempotencyKey, actorId, route, projectId = LEGACY_PROJECT_ID) {
    const contentHash = drawing.commandEvents?.at(-1)?.afterHash ?? `version-${drawing.version}`;
    const versionId = `ver_${drawing.id}_${String(drawing.version).padStart(3, "0")}`;
    const actor = drawing.auditLog?.at(-1)?.actor ?? drawing.currentRole ?? "system";
    try {
      await this.sql.begin(async (tx) => {
        await tx`
          insert into idempotency_keys (key, actor_id, route)
          values (${idempotencyKey}, ${actorId}, ${route})
        `;
        await tx`
          insert into drawings (id, project_id, name, unit, current_version, revision, state)
          values (
            ${drawing.id}, ${projectId}, ${drawing.name}, ${drawing.unit},
            ${drawing.version}, ${drawing.revision}, ${drawing.state}
          )
        `;
        await tx`
          insert into drawing_versions (
            id, drawing_id, version_no, state, content, content_hash, created_by
          )
          values (
            ${versionId}, ${drawing.id}, ${drawing.version}, ${drawing.state},
            ${tx.json(drawing)}, ${contentHash}, ${actor}
          )
        `;
        await tx`
          insert into audit_logs (id, actor_id, action, target_type, target_id, detail, created_at)
          values (
            ${auditEntry.id}, ${auditEntry.actorId}, ${auditEntry.action},
            ${auditEntry.targetType}, ${auditEntry.targetId},
            ${tx.json({ role: auditEntry.role, ...auditEntry.detail })},
            ${auditEntry.createdAt}
          )
        `;
      });
      return true;
    } catch (error) {
      if (error && typeof error === "object" && "code" in error && error.code === "23505") return false;
      throw error;
    }
  }

  async saveDrawingAtomically(drawing, auditEntry, idempotencyKey, actorId, route, agentRun = null) {
    const content = this.sql.json(drawing);
    const commandEvent = drawing.commandEvents?.at(-1) ?? null;
    const contentHash = commandEvent?.afterHash ?? `version-${drawing.version}`;
    const versionId = `ver_${drawing.id}_${String(drawing.version).padStart(3, "0")}`;
    const actor = drawing.auditLog?.at(-1)?.actor ?? drawing.currentRole ?? "system";
    const expectedRevision = drawing.revision - 1;
    const eventPayload = commandEvent ? this.sql.json(commandEvent.commands ?? []) : null;
    const agentProposal = agentRun ? this.sql.json(agentRun.proposal) : null;
    try {
      const rows = await this.sql`
        with drawing_write as (
          update drawings set
            name = ${drawing.name},
            unit = ${drawing.unit},
            current_version = ${drawing.version},
            revision = ${drawing.revision},
            state = ${drawing.state},
            updated_at = now()
          where id = ${drawing.id} and revision = ${expectedRevision}
            -- AI提案の承認は、提案が未適用(planned)の場合だけ図面を更新する(独立レビュー M-2)。
            and (${agentRun === null} or exists (
              select 1 from agent_runs where id = ${agentRun?.id ?? null} and status = 'planned'
            ))
          returning id
        ), version_write as (
          insert into drawing_versions (id, drawing_id, version_no, state, content, content_hash, created_by)
          select ${versionId}, ${drawing.id}, ${drawing.version}, ${drawing.state},
                 ${content}, ${contentHash}, ${actor}
          from drawing_write
          on conflict (drawing_id, version_no) do update set
            state = excluded.state,
            content = excluded.content,
            content_hash = excluded.content_hash
          returning id
        ), command_write as (
          insert into command_events (
            id, drawing_version_id, source, actor_id, label, command_payload,
            before_hash, after_hash, created_at
          )
          select ${commandEvent?.id ?? null}, version_write.id, ${commandEvent?.source ?? "system"},
                 ${actorId}, ${commandEvent?.label ?? "state transition"}, ${eventPayload},
                 ${commandEvent?.beforeHash ?? contentHash}, ${commandEvent?.afterHash ?? contentHash},
                 ${commandEvent?.at ?? new Date().toISOString()}
          from version_write
          where ${commandEvent !== null}
          on conflict (id) do nothing
          returning id
        ), audit_write as (
          insert into audit_logs (id, actor_id, action, target_type, target_id, detail, created_at)
          select ${auditEntry.id}, ${auditEntry.actorId}, ${auditEntry.action},
                 ${auditEntry.targetType}, ${auditEntry.targetId},
                 ${this.sql.json({ role: auditEntry.role, ...auditEntry.detail })},
                 ${auditEntry.createdAt}
          from drawing_write
          returning id
        ), agent_write as (
          update agent_runs set
            status = ${agentRun?.status ?? null},
            proposal = coalesce(${agentProposal}, proposal)
          where id = ${agentRun?.id ?? null}
            and status = 'planned'
            and exists (select 1 from drawing_write)
          returning id
        ), idempotency_write as (
          insert into idempotency_keys (key, actor_id, route)
          select ${idempotencyKey}, ${actorId}, ${route}
          from audit_write
          returning key
        )
        select key from idempotency_write
      `;
      if (rows.length === 0) {
        if (agentRun) {
          const runs = await this.sql`select status from agent_runs where id = ${agentRun.id} limit 1`;
          if (runs.length > 0 && runs[0].status !== "planned") throw agentRunConflictError(agentRun.id);
        }
        throw conflictError(null, expectedRevision);
      }
      return true;
    } catch (error) {
      if (error && typeof error === "object" && "code" in error && error.code === "23505") return false;
      throw error;
    }
  }

  async saveAgentRun(run) {
    await this.sql`
      insert into agent_runs (
        id, drawing_version_id, status, prompt, skill_id, skill_version,
        proposal, risk, created_by, created_at
      )
      select ${run.id}, v.id, ${run.status}, ${run.prompt},
             ${run.proposal.skill?.id ?? null}, ${run.proposal.skill?.version ?? null},
             ${this.sql.json(run.proposal)}, ${run.proposal.risk ?? "preview"},
             ${run.createdBy}, ${run.createdAt}
      from drawing_versions v
      where v.drawing_id = ${run.drawingId}
      order by v.version_no desc
      limit 1
      on conflict (id) do update set
        status = excluded.status,
        proposal = excluded.proposal
    `;
    return run;
  }

  async getAgentRun(id) {
    const rows = await this.sql`
      select a.id, v.drawing_id, a.status, a.prompt, a.proposal,
             a.created_by, a.created_at
      from agent_runs a
      join drawing_versions v on v.id = a.drawing_version_id
      where a.id = ${id}
      limit 1
    `;
    if (rows.length === 0) return null;
    const row = rows[0];
    return {
      id: row.id,
      drawingId: row.drawing_id,
      status: row.status,
      prompt: row.prompt,
      proposal: parseStoredJson(row.proposal),
      createdBy: row.created_by,
      createdAt: new Date(row.created_at).toISOString()
    };
  }

  // 監査行は「必ず1行記録される」ことを要求する。以前は `on conflict (id) do nothing`
  // のため、ID衝突時に戻り値も例外も無く黙って記録が落ちていた。衝突は
  // cryptoSafeId()由来のIDでは事実上起きないため、0行は異常として扱い呼び出し元の
  // 操作を失敗させる(承認判断の根拠が欠けた状態で成功を返さない)。
  async appendAudit(entry) {
    const rows = await this.sql`
      insert into audit_logs (id, actor_id, action, target_type, target_id, detail, created_at)
      values (${entry.id}, ${entry.actorId}, ${entry.action}, ${entry.targetType},
              ${entry.targetId}, ${this.sql.json({ role: entry.role, ...entry.detail })},
              ${entry.createdAt})
      on conflict (id) do nothing
      returning id
    `;
    if (rows.length !== 1) {
      throw new Error(`監査ログを記録できませんでした(重複IDまたは未挿入): ${entry.id}`);
    }
  }

  async listAuditLogs(limit = 100, offset = 0) {
    const safeLimit = Math.max(1, Math.min(1000, Number(limit) || 100));
    const safeOffset = Math.max(0, Number(offset) || 0);
    const rows = await this.sql`
      select id, actor_id, action, target_type, target_id, detail, created_at
      from audit_logs
      order by created_at desc
      limit ${safeLimit}
      offset ${safeOffset}
    `;
    return rows.map((row) => {
      const detail = parseStoredJson(row.detail);
      return {
        id: row.id,
        actorId: row.actor_id,
        role: detail?.role,
        action: row.action,
        targetType: row.target_type,
        targetId: row.target_id,
        detail,
        createdAt: new Date(row.created_at).toISOString()
      };
    });
  }

  async countAuditLogs() {
    const rows = await this.sql`select count(*)::int as total from audit_logs`;
    return rows[0].total;
  }

  async claimIdempotency(key, actorId, route) {
    const rows = await this.sql`
      insert into idempotency_keys (key, actor_id, route)
      values (${key}, ${actorId}, ${route})
      on conflict (key) do nothing
      returning key
    `;
    return rows.length === 1;
  }

  // 予約した冪等キーを取り消す。処理が失敗した場合に呼び、同じキーでの正しい再送を
  // 可能にする(予約を残したままだと恒久的に409になる)。
  async releaseIdempotency(key) {
    await this.sql`
      delete from idempotency_keys where key = ${key}
    `;
  }

  async hasIdempotency(key) {
    const rows = await this.sql`
      select exists (select 1 from idempotency_keys where key = ${key}) as claimed
    `;
    return rows[0].claimed;
  }
}

function ensureMemorySeed() {
  if (!memory.projects.has(LEGACY_PROJECT_ID)) {
    memory.projects.set(LEGACY_PROJECT_ID, {
      id: LEGACY_PROJECT_ID,
      name: "道路拡幅デモ案件",
      owner: "mirai-demo",
      status: "active",
      accessScope: "open"
    });
    memory.projectMembers.set(LEGACY_PROJECT_ID, new Set());
  }
  if (!memory.drawings.has("dwg_demo_001")) {
    memory.drawings.set("dwg_demo_001", seedDrawing());
    memory.drawingProjects.set("dwg_demo_001", LEGACY_PROJECT_ID);
  }
}

function isCadDrawing(value) {
  return Boolean(
    value &&
      Array.isArray(value.layers) &&
      value.layers.every((layer) => typeof layer === "object" && typeof layer.id === "string") &&
      Array.isArray(value.entities) &&
      Array.isArray(value.commandEvents) &&
      Array.isArray(value.auditLog)
  );
}

function parseStoredJson(value) {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function clone(value) {
  return value == null ? value : structuredClone(value);
}

function conflictError(actual, expected) {
  const detail = actual == null ? `expected=${expected}` : `expected=${expected}, actual=${actual}`;
  return Object.assign(new Error(`リビジョンが競合しています。${detail}`), { status: 409 });
}

function agentRunConflictError(runId) {
  return Object.assign(new Error(`AI提案は適用済みです: ${runId}`), { status: 409 });
}

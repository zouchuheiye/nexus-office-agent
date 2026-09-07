import { createPostgresDatabase } from "../src/platform/database/postgres";
import { getDevelopmentManagementRepository } from "../src/modules/management-loop/infrastructure/in-memory-repository";
import { DEMO_PROJECT_ID, DEMO_TENANT_ID } from "../src/platform/context/development-context";

const databaseUrl = process.env.DATABASE_URL;

async function main() {
  if (!databaseUrl) throw new Error("DATABASE_URL is not configured");

  const snapshot = await getDevelopmentManagementRepository().getSnapshot(DEMO_TENANT_ID, DEMO_PROJECT_ID);
  if (!snapshot) throw new Error("DEVELOPMENT_SNAPSHOT_NOT_FOUND");

  const database = createPostgresDatabase(databaseUrl);
  try {
    await database.withTenant(DEMO_TENANT_ID, async (db) => {
      const { objective, project } = snapshot;
      await db.query(`
        INSERT INTO objectives (id,tenant_id,title,description,owner_id,status,baseline,target_value,current_value,unit,starts_at,ends_at,review_cadence,version)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
        ON CONFLICT (id) DO UPDATE SET title=EXCLUDED.title,description=EXCLUDED.description,owner_id=EXCLUDED.owner_id,status=EXCLUDED.status,
          baseline=EXCLUDED.baseline,target_value=EXCLUDED.target_value,current_value=EXCLUDED.current_value,unit=EXCLUDED.unit,
          starts_at=EXCLUDED.starts_at,ends_at=EXCLUDED.ends_at,review_cadence=EXCLUDED.review_cadence,version=EXCLUDED.version,updated_at=now(),archived_at=NULL`,
        [objective.id, objective.tenantId, objective.title, objective.description, objective.ownerId, objective.status, objective.baseline ?? null, objective.targetValue ?? null, objective.currentValue ?? null, objective.unit ?? null, objective.startsAt, objective.endsAt, objective.reviewCadence, objective.version],
      );
      await db.query(`
        INSERT INTO projects (id,tenant_id,code,name,description,owner_id,status,priority,starts_at,target_end_at,health,version,business_value,acceptance_criteria,resource_plan,baseline_version)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,'{}'::jsonb,1)
        ON CONFLICT (id) DO UPDATE SET code=EXCLUDED.code,name=EXCLUDED.name,description=EXCLUDED.description,owner_id=EXCLUDED.owner_id,
          status=EXCLUDED.status,priority=EXCLUDED.priority,starts_at=EXCLUDED.starts_at,target_end_at=EXCLUDED.target_end_at,
          health=EXCLUDED.health,version=EXCLUDED.version,business_value=EXCLUDED.business_value,acceptance_criteria=EXCLUDED.acceptance_criteria,resource_plan=EXCLUDED.resource_plan,baseline_version=EXCLUDED.baseline_version,updated_at=now(),archived_at=NULL`,
        [project.id, project.tenantId, project.code, project.name, project.description, project.ownerId, project.status, project.priority, project.startsAt, project.targetEndAt, project.health, project.version, "提升华东核心客户交付满意度与客服效率，支撑按期交付率目标。", "核心业务场景连续 48 小时稳定，客户签署灰度验收单。"],
      );
      await db.query(`
        INSERT INTO objective_project_links (tenant_id,objective_id,project_id,contribution_weight)
        VALUES ($1,$2,$3,1)
        ON CONFLICT (tenant_id,objective_id,project_id) DO NOTHING`,
        [project.tenantId, objective.id, project.id],
      );
      await db.query(`
        INSERT INTO project_members (tenant_id,project_id,user_id,responsibility,allocation_percent)
        VALUES ($1,$2,$3,'accountable',100)
        ON CONFLICT (tenant_id,project_id,user_id,responsibility) DO UPDATE SET allocation_percent=EXCLUDED.allocation_percent`,
        [project.tenantId, project.id, project.ownerId],
      );

      for (const milestone of snapshot.milestones) {
        await db.query(`
          INSERT INTO milestones (id,tenant_id,project_id,name,owner_id,due_at,status,acceptance_criteria,version)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
          ON CONFLICT (id) DO UPDATE SET project_id=EXCLUDED.project_id,name=EXCLUDED.name,owner_id=EXCLUDED.owner_id,due_at=EXCLUDED.due_at,
            status=EXCLUDED.status,acceptance_criteria=EXCLUDED.acceptance_criteria,version=EXCLUDED.version,updated_at=now()`,
          [milestone.id, milestone.tenantId, milestone.projectId, milestone.name, milestone.ownerId, milestone.dueAt, milestone.status, milestone.acceptanceCriteria, milestone.version],
        );
      }
      for (const task of snapshot.tasks) {
        await db.query(`
          INSERT INTO tasks (id,tenant_id,project_id,milestone_id,parent_id,title,description,assignee_id,status,priority,due_at,completed_at,version)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
          ON CONFLICT (id) DO UPDATE SET project_id=EXCLUDED.project_id,milestone_id=EXCLUDED.milestone_id,parent_id=EXCLUDED.parent_id,
            title=EXCLUDED.title,description=EXCLUDED.description,assignee_id=EXCLUDED.assignee_id,status=EXCLUDED.status,priority=EXCLUDED.priority,
            due_at=EXCLUDED.due_at,completed_at=EXCLUDED.completed_at,version=EXCLUDED.version,updated_at=now()`,
          [task.id, task.tenantId, task.projectId, task.milestoneId ?? null, task.parentId ?? null, task.title, task.description, task.assigneeId, task.status, task.priority, task.dueAt ?? null, task.completedAt ?? null, task.version],
        );
      }
      for (const risk of snapshot.risks) {
        await db.query(`
          INSERT INTO risks (id,tenant_id,project_id,title,description,owner_id,probability,impact,status,response_strategy,response_plan,review_at,source_type,source_ref,version)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
          ON CONFLICT (id) DO UPDATE SET project_id=EXCLUDED.project_id,title=EXCLUDED.title,description=EXCLUDED.description,owner_id=EXCLUDED.owner_id,
            probability=EXCLUDED.probability,impact=EXCLUDED.impact,status=EXCLUDED.status,response_strategy=EXCLUDED.response_strategy,
            response_plan=EXCLUDED.response_plan,review_at=EXCLUDED.review_at,source_type=EXCLUDED.source_type,source_ref=EXCLUDED.source_ref,version=EXCLUDED.version,updated_at=now()`,
          [risk.id, risk.tenantId, risk.projectId, risk.title, risk.description, risk.ownerId, risk.probability, risk.impact, risk.status, risk.responseStrategy ?? null, risk.responsePlan ?? null, risk.reviewAt ?? null, risk.sourceType, risk.sourceRef ?? null, risk.version],
        );
      }
      for (const issue of snapshot.issues) {
        await db.query(`
          INSERT INTO issues (id,tenant_id,project_id,risk_id,title,description,owner_id,severity,status,resolution,version)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
          ON CONFLICT (id) DO UPDATE SET project_id=EXCLUDED.project_id,risk_id=EXCLUDED.risk_id,title=EXCLUDED.title,description=EXCLUDED.description,
            owner_id=EXCLUDED.owner_id,severity=EXCLUDED.severity,status=EXCLUDED.status,resolution=EXCLUDED.resolution,version=EXCLUDED.version,updated_at=now()`,
          [issue.id, issue.tenantId, issue.projectId, issue.riskId ?? null, issue.title, issue.description, issue.ownerId, issue.severity, issue.status, issue.resolution ?? null, issue.version],
        );
      }
      for (const decision of snapshot.decisions) {
        await db.query(`
          INSERT INTO decisions (id,tenant_id,project_id,risk_id,title,context,options,selected_option,rationale,owner_id,decided_by,status,review_at,supersedes_id,version)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
          ON CONFLICT (id) DO UPDATE SET project_id=EXCLUDED.project_id,risk_id=EXCLUDED.risk_id,title=EXCLUDED.title,context=EXCLUDED.context,
            options=EXCLUDED.options,selected_option=EXCLUDED.selected_option,rationale=EXCLUDED.rationale,owner_id=EXCLUDED.owner_id,decided_by=EXCLUDED.decided_by,
            status=EXCLUDED.status,review_at=EXCLUDED.review_at,supersedes_id=EXCLUDED.supersedes_id,version=EXCLUDED.version,updated_at=now()`,
          [decision.id, decision.tenantId, decision.projectId ?? null, decision.riskId ?? null, decision.title, decision.context, decision.options, decision.selectedOption ?? null, decision.rationale ?? null, decision.ownerId, decision.decidedBy ?? null, decision.status, decision.reviewAt ?? null, decision.supersedesId ?? null, decision.version],
        );
      }
      for (const item of snapshot.actionItems) {
        await db.query(`
          INSERT INTO action_items (id,tenant_id,decision_id,project_id,title,description,owner_id,due_at,acceptance_criteria,status,completed_at,completion_evidence,version)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
          ON CONFLICT (id) DO UPDATE SET decision_id=EXCLUDED.decision_id,project_id=EXCLUDED.project_id,title=EXCLUDED.title,description=EXCLUDED.description,
            owner_id=EXCLUDED.owner_id,due_at=EXCLUDED.due_at,acceptance_criteria=EXCLUDED.acceptance_criteria,status=EXCLUDED.status,
            completed_at=EXCLUDED.completed_at,completion_evidence=EXCLUDED.completion_evidence,version=EXCLUDED.version,updated_at=now()`,
          [item.id, item.tenantId, item.decisionId ?? null, item.projectId ?? null, item.title, item.description, item.ownerId, item.dueAt, item.acceptanceCriteria, item.status, item.completedAt ?? null, item.completionEvidence ?? null, item.version],
        );
      }
    });
    console.log(JSON.stringify({ seeded: true, projectId: snapshot.project.id, project: snapshot.project.name, milestones: snapshot.milestones.length, tasks: snapshot.tasks.length, risks: snapshot.risks.length }));
  } finally {
    await database.close();
  }
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

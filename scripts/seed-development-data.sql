BEGIN;
SELECT set_config('app.tenant_id', '00000000-0000-4000-8000-000000000001', true);

INSERT INTO objectives (id,tenant_id,title,description,owner_id,status,baseline,target_value,current_value,unit,starts_at,ends_at,review_cadence,version)
VALUES ('40000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000001','核心客户按期交付率达到 95%','通过交付标准化和风险前置管理提升企业客户体验。','10000000-0000-4000-8000-000000000001','active',82,95,88,'%','2026-07-01','2026-09-30','weekly',1)
ON CONFLICT (id) DO UPDATE SET title=EXCLUDED.title,description=EXCLUDED.description,status=EXCLUDED.status,baseline=EXCLUDED.baseline,target_value=EXCLUDED.target_value,current_value=EXCLUDED.current_value,unit=EXCLUDED.unit,starts_at=EXCLUDED.starts_at,ends_at=EXCLUDED.ends_at,version=EXCLUDED.version,updated_at=now(),archived_at=NULL;

INSERT INTO projects (id,tenant_id,code,name,description,owner_id,status,priority,starts_at,target_end_at,health,version,business_value,acceptance_criteria,resource_plan,baseline_version)
VALUES ('30000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000001','PRJ-2026-018','智能客服 2.0 华东上线','为华东核心客户交付智能客服升级和灰度上线。','10000000-0000-4000-8000-000000000001','active','critical','2026-07-15','2026-08-21','at_risk',3,'提升华东核心客户交付满意度与客服效率，支撑按期交付率目标。','核心业务场景连续 48 小时稳定，客户签署灰度验收单。','{}'::jsonb,1)
ON CONFLICT (id) DO UPDATE SET code=EXCLUDED.code,name=EXCLUDED.name,description=EXCLUDED.description,owner_id=EXCLUDED.owner_id,status=EXCLUDED.status,priority=EXCLUDED.priority,starts_at=EXCLUDED.starts_at,target_end_at=EXCLUDED.target_end_at,health=EXCLUDED.health,version=EXCLUDED.version,business_value=EXCLUDED.business_value,acceptance_criteria=EXCLUDED.acceptance_criteria,resource_plan=EXCLUDED.resource_plan,baseline_version=EXCLUDED.baseline_version,updated_at=now(),archived_at=NULL;

INSERT INTO objective_project_links (tenant_id,objective_id,project_id,contribution_weight)
VALUES ('00000000-0000-4000-8000-000000000001','40000000-0000-4000-8000-000000000001','30000000-0000-4000-8000-000000000001',1)
ON CONFLICT DO NOTHING;

INSERT INTO project_members (tenant_id,project_id,user_id,responsibility,allocation_percent)
VALUES ('00000000-0000-4000-8000-000000000001','30000000-0000-4000-8000-000000000001','10000000-0000-4000-8000-000000000001','accountable',100)
ON CONFLICT (tenant_id,project_id,user_id,responsibility) DO UPDATE SET allocation_percent=EXCLUDED.allocation_percent;

INSERT INTO milestones (id,tenant_id,project_id,name,owner_id,due_at,status,acceptance_criteria,version)
VALUES ('60000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000001','30000000-0000-4000-8000-000000000001','华东客户灰度验收','10000000-0000-4000-8000-000000000001','2026-08-21','at_risk','核心业务场景连续 48 小时稳定，客户签署灰度验收单。',2)
ON CONFLICT (id) DO UPDATE SET name=EXCLUDED.name,owner_id=EXCLUDED.owner_id,due_at=EXCLUDED.due_at,status=EXCLUDED.status,acceptance_criteria=EXCLUDED.acceptance_criteria,version=EXCLUDED.version,updated_at=now();

INSERT INTO tasks (id,tenant_id,project_id,milestone_id,title,description,assignee_id,status,priority,due_at,version)
VALUES
('70000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000001','30000000-0000-4000-8000-000000000001','60000000-0000-4000-8000-000000000001','完成接口联调回归','覆盖订单、工单和客户身份三个关键链路。','10000000-0000-4000-8000-000000000001','in_progress','critical','2026-08-06T10:00:00+08:00',2),
('70000000-0000-4000-8000-000000000002','00000000-0000-4000-8000-000000000001','30000000-0000-4000-8000-000000000001','60000000-0000-4000-8000-000000000001','准备 30% 灰度发布脚本','包含放量、观测和一键回滚步骤。','10000000-0000-4000-8000-000000000001','in_review','high','2026-08-06T15:00:00+08:00',3),
('70000000-0000-4000-8000-000000000003','00000000-0000-4000-8000-000000000001','30000000-0000-4000-8000-000000000001','60000000-0000-4000-8000-000000000001','确认客户验收人与时间窗','取得客户侧书面确认并同步上线群。','10000000-0000-4000-8000-000000000001','blocked','high','2026-08-07T11:00:00+08:00',2)
ON CONFLICT (id) DO UPDATE SET project_id=EXCLUDED.project_id,milestone_id=EXCLUDED.milestone_id,title=EXCLUDED.title,description=EXCLUDED.description,assignee_id=EXCLUDED.assignee_id,status=EXCLUDED.status,priority=EXCLUDED.priority,due_at=EXCLUDED.due_at,version=EXCLUDED.version,updated_at=now();

INSERT INTO risks (id,tenant_id,project_id,title,description,owner_id,probability,impact,status,review_at,source_type,source_ref,version)
VALUES ('50000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000001','30000000-0000-4000-8000-000000000001','接口联调晚于基线 2 天','客户侧接口环境交付延迟，压缩灰度验证窗口。','10000000-0000-4000-8000-000000000001',4,4,'assessed','2026-08-05T11:00:00+08:00','event','demo:event:integration-delay',1)
ON CONFLICT (id) DO UPDATE SET project_id=EXCLUDED.project_id,title=EXCLUDED.title,description=EXCLUDED.description,owner_id=EXCLUDED.owner_id,probability=EXCLUDED.probability,impact=EXCLUDED.impact,status=EXCLUDED.status,review_at=EXCLUDED.review_at,source_type=EXCLUDED.source_type,source_ref=EXCLUDED.source_ref,version=EXCLUDED.version,updated_at=now();

-- Link any existing non-template work missions to the demo project so the people x project views have real relations.
UPDATE work_missions
   SET project_id='30000000-0000-4000-8000-000000000001', updated_at=now()
 WHERE tenant_id='00000000-0000-4000-8000-000000000001'
   AND project_id IS NULL
   AND is_template=false;

-- Demo announcement for the announcement center (kind=announcement vs notice).
INSERT INTO work_pool_messages (id,tenant_id,pool_scope,org_unit_id,subject,content,kind,author_id,source,source_run_id,created_at)
VALUES ('80000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000001','company',NULL,'【公告】公告中心已上线','公告与通知已分开展示；发布公告走 Agent 提案确认，不直接落库。','announcement','10000000-0000-4000-8000-000000000001','human',NULL,now())
ON CONFLICT (id) DO NOTHING;

COMMIT;

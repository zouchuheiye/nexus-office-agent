BEGIN;

-- F-081: structured handoff card (current progress / completed / pending / attention).
ALTER TABLE work_task_handoffs
  ADD COLUMN current_progress text,
  ADD COLUMN completed_work text,
  ADD COLUMN pending_work text,
  ADD COLUMN attention_points text;

COMMIT;

BEGIN;

-- Task progress tracking (F-077): start time + estimated duration for formal task packages.
ALTER TABLE work_packages
  ADD COLUMN started_at timestamptz,
  ADD COLUMN estimated_days integer
    CHECK (estimated_days IS NULL OR (estimated_days BETWEEN 1 AND 365));

CREATE INDEX idx_work_packages_due_tracking ON work_packages(tenant_id,status,due_at);

COMMIT;

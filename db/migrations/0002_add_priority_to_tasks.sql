ALTER TABLE tasks
ADD COLUMN priority TEXT NOT NULL DEFAULT 'medium'
CHECK (priority IN ('high', 'medium', 'low'));

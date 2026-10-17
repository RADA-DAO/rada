-- JSON lines preserve arbitrary quoted identifiers and bigint precision.
SELECT format(
  'SELECT json_build_array(%L, %L, %L, %L, count(*)::text)::text FROM ONLY %I.%I;',
  n.nspname, c.relname, c.relkind, c.relispartition::text, n.nspname, c.relname
)
FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE c.relkind IN ('r', 'p') AND n.nspname NOT IN ('pg_catalog', 'information_schema')
  AND n.nspname !~ '^pg_toast' AND n.nspname !~ '^pg_temp'
ORDER BY n.nspname COLLATE "C", c.relname COLLATE "C"
\gexec

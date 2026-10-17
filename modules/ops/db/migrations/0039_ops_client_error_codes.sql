SET LOCAL ROLE ops_owner;

-- Existing reports keep their diagnostic metadata without free-form messages.
UPDATE ops.client_errors SET message = 'unknown';
ALTER TABLE ops.client_errors ADD CONSTRAINT client_errors_message_code CHECK (
  message IN (
    'unknown', 'type_error', 'range_error', 'reference_error', 'syntax_error',
    'uri_error', 'eval_error', 'aggregate_error', 'abort_error', 'timeout_error'
  )
);

RESET ROLE;

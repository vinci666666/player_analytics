-- 建立獨立交易寫入的伺服器稽核表。 / Create the server audit table written through independent transactions.
-- 事件類型 / Event types: 1 = information, 2 = warning, 3 = error, 4 = authentication.
CREATE TABLE IF NOT EXISTS public.server_action_log (
    time_utc7       TIMESTAMP WITHOUT TIME ZONE NOT NULL,
    message_type_id SMALLINT NOT NULL,
    message_content TEXT NOT NULL,
    CONSTRAINT server_action_log_message_type_check
        CHECK (message_type_id IN (1, 2, 3, 4))
);

CREATE INDEX IF NOT EXISTS idx_server_action_log_time_utc7
    ON public.server_action_log (time_utc7 DESC);

CREATE INDEX IF NOT EXISTS idx_server_action_log_type_time
    ON public.server_action_log (message_type_id, time_utc7 DESC);

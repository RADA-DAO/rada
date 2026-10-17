-- Synthetic only. Load into a NEW disposable source database, never a target.
CREATE TABLE public.ecosystem_users (
  id uuid PRIMARY KEY, telegram_id bigint, display_name text,
  global_balance numeric, wallet_address text, created_at timestamptz NOT NULL
);
INSERT INTO public.ecosystem_users
SELECT ('10000000-0000-4000-8000-' || lpad(n::text,12,'0'))::uuid,
  CASE WHEN n = 8 THEN NULL ELSE 81000+n END,
  CASE WHEN n IN (1,2) THEN 'Same display name' ELSE 'Synthetic person' END,
  999, 'synthetic-wallet-evidence', '2026-01-01T00:00:00Z' FROM generate_series(1,8) n;
CREATE TABLE public.jpegpe_frog_submissions (
  id uuid PRIMARY KEY, username text, name text, creator_telegram_user_id bigint,
  owner_telegram_user_id bigint, splash_state text, background_color text, accent_color text,
  background_drop_request_id uuid, accent_drop_request_id uuid, created_at timestamptz NOT NULL
);
INSERT INTO public.jpegpe_frog_submissions
SELECT ('20000000-0000-4000-8000-' || lpad(n::text,12,'0'))::uuid,
  CASE n WHEN 5 THEN '@Collision' WHEN 6 THEN '@collision' ELSE '@Fixture_' || n END,
  'Synthetic frog', 81001,
  CASE WHEN n = 7 THEN NULL WHEN n = 1 THEN 81003 WHEN n = 2 THEN 81002 ELSE 81001 END,
  CASE WHEN n = 7 THEN 'archived' ELSE 'owned' END,
  '#123AbC', '#FEDCBA', NULL, NULL, '2026-01-02T00:00:00Z' FROM generate_series(1,8) n;
CREATE TABLE public.jpegpe_color_drop_requests(request_id uuid PRIMARY KEY, proof jsonb);
INSERT INTO public.jpegpe_color_drop_requests VALUES
  ('30000000-0000-4000-8000-000000000001', '{"synthetic":true,"protocolVersion":1}');
UPDATE public.jpegpe_frog_submissions SET background_drop_request_id = '30000000-0000-4000-8000-000000000001'
WHERE id = '20000000-0000-4000-8000-000000000001';
CREATE TABLE public.jpegpe_frog_market_listings (
  id uuid PRIMARY KEY, frog_id uuid, seller_telegram_user_id bigint,
  buyer_telegram_user_id bigint, sold_at timestamptz, status text, price bigint
);
INSERT INTO public.jpegpe_frog_market_listings VALUES
  ('40000000-0000-4000-8000-000000000001','20000000-0000-4000-8000-000000000001',81001,81002,'2026-01-03T00:00:00Z','sold',123),
  ('40000000-0000-4000-8000-000000000002','20000000-0000-4000-8000-000000000001',81002,81003,'2026-01-04T00:00:00Z','sold',456);
CREATE TABLE public.jpegpe_profile_appearances(telegram_user_id bigint PRIMARY KEY, document jsonb);
INSERT INTO public.jpegpe_profile_appearances VALUES
  (81001, '{"profile":{"frogId":"20000000-0000-4000-8000-000000000001"}}'),
  (81003, '{"profile":{"frogId":"20000000-0000-4000-8000-000000000001"}}');
CREATE TABLE public.jpegpe_game_accounts(telegram_user_id bigint, balance bigint, reserved bigint);
INSERT INTO public.jpegpe_game_accounts VALUES (81001,10000,50),(81002,20000,0);
CREATE TABLE public.wallet_links(id integer, address text);
INSERT INTO public.wallet_links VALUES (1,'synthetic-wallet');
CREATE TABLE public.sessions(id integer);
INSERT INTO public.sessions VALUES (1),(2);
CREATE TABLE public.admin_roles(id integer);
INSERT INTO public.admin_roles VALUES (1);
CREATE TABLE public.challenges(id integer);
INSERT INTO public.challenges VALUES (1);
CREATE TABLE public.global_balance_history(id integer, amount numeric);
INSERT INTO public.global_balance_history VALUES (1,123);

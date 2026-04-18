-- ============================================================
-- living instrument — supabase schema
-- paste the whole file into Supabase → SQL Editor → Run
-- safe to run more than once (idempotent)
-- ============================================================

-- ---------- tables ----------

-- single-row soul. id is locked to 1.
create table if not exists public.soul (
  id          int primary key,
  state       jsonb not null default '{}'::jsonb,
  leader_id   text,
  leader_seen timestamptz,
  updated_at  timestamptz not null default now(),
  check (id = 1)
);

insert into public.soul (id, state)
values (1, '{}'::jsonb)
on conflict (id) do nothing;

-- voice fragments
create table if not exists public.samples (
  id         uuid primary key default gen_random_uuid(),
  path       text not null,                          -- object path inside the 'fragments' bucket
  mime       text not null default 'audio/webm',
  duration   real not null default 5.0,
  created_at timestamptz not null default now()
);

create index if not exists samples_created_at_idx on public.samples (created_at desc);

-- keep updated_at fresh on soul writes
create or replace function public.touch_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists soul_touch on public.soul;
create trigger soul_touch before update on public.soul
for each row execute function public.touch_updated_at();

-- ---------- realtime ----------

-- add tables to the realtime publication (safe to repeat)
do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'soul'
  ) then
    execute 'alter publication supabase_realtime add table public.soul';
  end if;
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'samples'
  ) then
    execute 'alter publication supabase_realtime add table public.samples';
  end if;
end $$;

-- ---------- row level security ----------
-- fully public collaborative instrument. anyone can read and write.

alter table public.soul    enable row level security;
alter table public.samples enable row level security;

drop policy if exists "soul read"         on public.soul;
drop policy if exists "soul update"       on public.soul;
drop policy if exists "samples read"      on public.samples;
drop policy if exists "samples insert"    on public.samples;
drop policy if exists "samples delete"    on public.samples;

create policy "soul read"      on public.soul    for select using (true);
create policy "soul update"    on public.soul    for update using (true) with check (true);
create policy "samples read"   on public.samples for select using (true);
create policy "samples insert" on public.samples for insert with check (true);
create policy "samples delete" on public.samples for delete using (true);

-- ---------- storage ----------

-- public 'fragments' bucket, 10 MB cap, audio only
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'fragments',
  'fragments',
  true,
  10485760,
  array['audio/webm','audio/ogg','audio/mp4','audio/mpeg','audio/wav','audio/x-wav']
)
on conflict (id) do update set
  public             = excluded.public,
  file_size_limit    = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists "fragments read"   on storage.objects;
drop policy if exists "fragments upload" on storage.objects;
drop policy if exists "fragments delete" on storage.objects;

create policy "fragments read"
  on storage.objects for select
  using (bucket_id = 'fragments');

create policy "fragments upload"
  on storage.objects for insert
  with check (bucket_id = 'fragments');

create policy "fragments delete"
  on storage.objects for delete
  using (bucket_id = 'fragments');

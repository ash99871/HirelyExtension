-- No usa profile_versions ni cambia las tablas existentes de Hirely.
create table if not exists public.saved_answers (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  question_text text not null check (length(trim(question_text)) > 0),
  answer_text text not null check (length(trim(answer_text)) > 0),
  category text,
  context text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists saved_answers_user_updated_idx
  on public.saved_answers (user_id, updated_at desc);

alter table public.saved_answers enable row level security;

-- Mínimo privilegio: la clave anon pública (la que viaja en la extensión) no puede tocar esta tabla
-- aunque algún día se creara por error una política permisiva. Solo usuarios autenticados.
revoke all on public.saved_answers from anon;
grant select, insert, update, delete on public.saved_answers to authenticated;

drop policy if exists "Users can read their saved answers" on public.saved_answers;
create policy "Users can read their saved answers"
  on public.saved_answers for select
  to authenticated
  using (auth.uid() = user_id);

drop policy if exists "Users can create their saved answers" on public.saved_answers;
create policy "Users can create their saved answers"
  on public.saved_answers for insert
  to authenticated
  with check (auth.uid() = user_id);

drop policy if exists "Users can update their saved answers" on public.saved_answers;
create policy "Users can update their saved answers"
  on public.saved_answers for update
  to authenticated
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

drop policy if exists "Users can delete their saved answers" on public.saved_answers;
create policy "Users can delete their saved answers"
  on public.saved_answers for delete
  to authenticated
  using (auth.uid() = user_id);

create or replace function public.set_saved_answers_updated_at()
returns trigger language plpgsql set search_path = '' as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists saved_answers_updated_at on public.saved_answers;
create trigger saved_answers_updated_at
before update on public.saved_answers
for each row execute function public.set_saved_answers_updated_at();

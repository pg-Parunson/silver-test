-- 응시자 랭킹: id = 정규화 성명의 SHA-256 앞 16자 (서버에는 마스킹된 이름만 저장)
create table if not exists public.rankings (
  id text primary key,
  name_masked text not null,
  score int not null check (score between 0 and 100),
  attempts int not null default 1,
  duration_ms bigint,
  updated_at timestamptz not null default now()
);

alter table public.rankings enable row level security;

-- 개인 학습용 공개 스코어보드: 익명 읽기/쓰기 허용
create policy "rankings_select" on public.rankings for select using (true);
create policy "rankings_insert" on public.rankings for insert with check (true);
create policy "rankings_update" on public.rankings for update using (true) with check (true);

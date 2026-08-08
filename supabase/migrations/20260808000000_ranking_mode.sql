-- 시험 유형별 랭킹 분리: 'full'(전체 시험) / 'sa'(주관식 집중)
-- 기존 행은 전부 전체 시험 기록이므로 default 'full'로 채운다.
alter table public.rankings add column if not exists mode text not null default 'full';

create index if not exists rankings_mode_score_idx
  on public.rankings (mode, score desc, updated_at asc);

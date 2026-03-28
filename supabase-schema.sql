-- Run this in Supabase SQL Editor

create table entries (
  id uuid default gen_random_uuid() primary key,
  user_name text not null,
  date date not null,
  conversations int default 0,
  follow_ups int default 0,
  booked_calls int default 0,
  conversion_rate int default 0,
  saved_at timestamptz default now(),
  unique(user_name, date)
);

-- Enable Row Level Security
alter table entries enable row level security;

-- Allow all operations for anon users (auth is PIN-based in the app)
create policy "Allow all for anon" on entries
  for all to anon
  using (true)
  with check (true);

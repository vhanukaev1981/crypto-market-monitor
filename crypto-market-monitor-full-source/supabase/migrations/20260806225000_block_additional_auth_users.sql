create or replace function private.block_additional_auth_users()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if exists (select 1 from auth.users) then
    raise exception using
      errcode = '42501',
      message = 'Additional user creation is disabled for this personal system';
  end if;
  return new;
end;
$$;

revoke all on function private.block_additional_auth_users() from public, anon, authenticated;

drop trigger if exists block_additional_auth_users on auth.users;
create trigger block_additional_auth_users
before insert on auth.users
for each row
execute function private.block_additional_auth_users();

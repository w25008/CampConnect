-- Tests for edit_audience_post() after 0024 and 0025.
-- Run the whole file in the Supabase SQL editor (or psql) as the migration
-- role. The test always ends by raising an error, so everything it creates
-- (four test accounts, a group, three posts) is rolled back. Read the result
-- in the error message: every line should end in "true", and test 6 should
-- say "after 30 edits".
--
-- The test sets the login token by hand. It must include the email, because
-- the 0003 policies check the token's email before showing any row.
do $test$
declare
  a uuid := '00000000-0000-4000-8000-0000000000a1';  -- group owner
  b uuid := '00000000-0000-4000-8000-0000000000b2';  -- removed member
  c uuid := '00000000-0000-4000-8000-0000000000c3';  -- current member
  d uuid := '00000000-0000-4000-8000-0000000000d4';  -- edits a school post
  g uuid := '00000000-0000-4000-8000-00000000a001';
  pb uuid := '00000000-0000-4000-8000-00000000b001';
  pc uuid := '00000000-0000-4000-8000-00000000b002';
  pd uuid := '00000000-0000-4000-8000-00000000b003';
  v_ok boolean; v_before timestamptz; v_after timestamptz; v_recipients uuid[];
  v_calls integer; v_results text[] := '{}'; v_seen integer;
begin
  insert into auth.users (id, email, email_confirmed_at, aud, role, raw_user_meta_data) values
    (a, 'zz_test_owner@osfl.ac.jp', now(), 'authenticated', 'authenticated', '{}'),
    (b, 'zz_test_removed@osfl.ac.jp', now(), 'authenticated', 'authenticated', '{}'),
    (c, 'zz_test_member@osfl.ac.jp', now(), 'authenticated', 'authenticated', '{}'),
    (d, 'zz_test_editor@osfl.ac.jp', now(), 'authenticated', 'authenticated', '{}');
  insert into public.student_groups (id, name, owner_id) values (g, 'Test group', a);
  insert into public.student_group_members (group_id, user_id, joined_at) values
    (g, a, now() - interval '1 hour'), (g, b, now() - interval '1 hour'), (g, c, now() - interval '1 hour')
  on conflict (group_id, user_id) do update set joined_at = excluded.joined_at;
  insert into public.posts (id, author_id, body, audience, group_id) values
    (pb, b, 'B group post', 'group', g),
    (pc, c, 'C group post', 'group', g),
    (pd, d, 'D school post', 'school', null);
  -- B is removed from the group, the same as remove_student_group_member() does.
  delete from public.student_group_members where group_id = g and user_id = b;

  -- 1. A removed member cannot edit their old group post.
  execute 'set local role authenticated';
  perform set_config('request.jwt.claims', json_build_object(
    'sub', b, 'role', 'authenticated', 'email', 'zz_test_removed@osfl.ac.jp')::text, true);
  v_ok := false;
  begin
    perform public.edit_audience_post(pb, 'now public', 'school', null, null, '{}');
  exception when others then
    if sqlerrm = 'Post not found or edit not allowed' then v_ok := true;
    else v_results := v_results || ('1 unexpected: ' || sqlerrm); end if;
  end;
  v_results := v_results || ('1 removed member blocked: ' || v_ok);

  -- 2. A current member can still edit their group post.
  perform set_config('request.jwt.claims', json_build_object(
    'sub', c, 'role', 'authenticated', 'email', 'zz_test_member@osfl.ac.jp')::text, true);
  begin
    perform public.edit_audience_post(pc, 'C edited', 'group', null, g, '{}');
    v_results := v_results || '2 current member can edit: true'::text;
  exception when others then
    v_results := v_results || ('2 current member can edit: false (' || sqlerrm || ')');
  end;

  -- 3-6 run as D on D's school-wide post.
  perform set_config('request.jwt.claims', json_build_object(
    'sub', d, 'role', 'authenticated', 'email', 'zz_test_editor@osfl.ac.jp')::text, true);
  select count(*) into v_seen from public.posts where id = pd;
  v_results := v_results || ('setup D can read own post: ' || (v_seen = 1));

  -- 3. Saving without changes does not mark the post as edited.
  execute 'reset role';
  update public.posts set edited_at = now() - interval '1 day' where id = pd;
  execute 'set local role authenticated';
  select edited_at into v_before from public.posts where id = pd;
  perform public.edit_audience_post(pd, 'D school post', 'school', null, null, '{}');
  select edited_at into v_after from public.posts where id = pd;
  v_results := v_results || ('3 no-op save leaves edited_at: '
    || (v_before is not null and v_after is not distinct from v_before));

  -- 4. Changing only the recipients rewrites them and marks the post edited.
  perform public.edit_audience_post(pd, 'D school post', 'selected', array[a], null, '{}');
  execute 'reset role';
  update public.posts set edited_at = null where id = pd;
  execute 'set local role authenticated';
  perform public.edit_audience_post(pd, 'D school post', 'selected', array[c], null, '{}');
  select edited_at into v_after from public.posts where id = pd;
  select array_agg(user_id) into v_recipients from public.post_recipients where post_id = pd;
  v_results := v_results || ('4 recipient-only change marks edited: ' || (v_after is not null)
    || ', recipients rewritten: ' || (v_recipients is not distinct from array[c]));

  -- 5. More than 200 recipients is rejected.
  v_ok := false;
  begin
    perform public.edit_audience_post(pd, 'D school post', 'selected',
      array(select gen_random_uuid() from generate_series(1, 201)), null, '{}');
  exception when others then
    if sqlerrm = 'Choose at most 200 students' then v_ok := true;
    else v_results := v_results || ('5 unexpected: ' || sqlerrm); end if;
  end;
  v_results := v_results || ('5 201 recipients rejected: ' || v_ok);

  -- 6. Edits are limited to 30 a minute. Tests 3 and 4 already used 3 of D's
  --    edits; test 5 failed, so it did not count.
  v_calls := 3; v_ok := false;
  while v_calls < 40 and not v_ok loop
    begin
      perform public.edit_audience_post(pd, 'D edit ' || v_calls, 'school', null, null, '{}');
      v_calls := v_calls + 1;
    exception when others then
      if sqlerrm like 'You are doing that too often%' then v_ok := true;
      else v_results := v_results || ('6 unexpected: ' || sqlerrm); exit; end if;
    end;
  end loop;
  v_results := v_results || ('6 rate limited: ' || v_ok || ' after ' || v_calls || ' edits (expect 30)');

  execute 'reset role';
  raise exception 'TEST RESULTS (rolled back): %', array_to_string(v_results, ' | ');
end
$test$;

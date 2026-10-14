-- La extensión y la web usan la clave pública (anon): lo único que protege los datos es RLS.

-- 1) RLS debe estar ACTIVO (rowsecurity = true) en todas las tablas que lee la extensión.
select schemaname, tablename, rowsecurity as rls_activo
from pg_tables
where schemaname = 'public' and tablename in ('profiles', 'saved_answers');

-- 2) Políticas existentes. Cada una debe limitarse a `authenticated` y comparar auth.uid() con user_id.
--    Señales de alarma: roles = {public} o {anon}, o qual = true.
select tablename, policyname, cmd, roles, qual as using_expr, with_check
from pg_policies
where schemaname = 'public' and tablename in ('profiles', 'saved_answers')
order by tablename, cmd;

-- 3) Privilegios del rol anon (lo ideal: ninguna fila para estas tablas).
select table_name, privilege_type
from information_schema.role_table_grants
where grantee = 'anon' and table_schema = 'public' and table_name in ('profiles', 'saved_answers');



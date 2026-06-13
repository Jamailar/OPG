-- Remove proprietary AI assistant (xitun language-learning) tables.
DROP TABLE IF EXISTS ai_assistant_messages CASCADE;
DROP TABLE IF EXISTS ai_assistant_sessions CASCADE;
DROP TABLE IF EXISTS ai_assistant_app_settings CASCADE;

-- Remove COACH role (谈案宝学习小组教练角色).
UPDATE users SET role = 'USER' WHERE role::text = 'COACH';

CREATE TYPE "UserRole_new" AS ENUM ('USER', 'ADMIN');
ALTER TABLE users ALTER COLUMN role DROP DEFAULT;
ALTER TABLE users
  ALTER COLUMN role TYPE "UserRole_new"
  USING (role::text::"UserRole_new");
ALTER TABLE users ALTER COLUMN role SET DEFAULT 'USER';
DROP TYPE "UserRole";
ALTER TYPE "UserRole_new" RENAME TO "UserRole";

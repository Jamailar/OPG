-- Remove proprietary business tables (谈案宝客户/录音/复盘、学习小组等) from the open-source baseline.
DROP TABLE IF EXISTS reviews CASCADE;
DROP TABLE IF EXISTS recordings CASCADE;
DROP TABLE IF EXISTS review_sessions CASCADE;
DROP TABLE IF EXISTS study_group_members CASCADE;
DROP TABLE IF EXISTS study_groups CASCADE;
DROP TABLE IF EXISTS clients CASCADE;

-- Create least-privilege MySQL user for MTR Dashboard app.
-- Usage:
--   sudo mysql < backend/scripts/create_mysql_app_user.sql
-- Then set matching credentials in backend/.env and frontend/.env.local.

CREATE DATABASE IF NOT EXISTS mtr_dashboard;

CREATE USER IF NOT EXISTS 'mtr_root'@'localhost' IDENTIFIED BY 'password123';

-- Minimal privileges required for current code paths.
GRANT SELECT, INSERT, UPDATE, DELETE ON mtr_dashboard.devices TO 'mtr_app'@'localhost';
GRANT SELECT, INSERT, UPDATE ON mtr_dashboard.polling_jobs TO 'mtr_app'@'localhost';

FLUSH PRIVILEGES;

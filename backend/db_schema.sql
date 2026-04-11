-- MySQL Schema for MTR Dashboard
-- Run this script to create the necessary tables

CREATE DATABASE IF NOT EXISTS mtr_dashboard;
USE mtr_dashboard;

-- Devices table: stores device inventory (IPs, Hostnames)
CREATE TABLE IF NOT EXISTS devices (
    id INT AUTO_INCREMENT PRIMARY KEY,
    ip_address VARCHAR(45) NOT NULL UNIQUE,
    hostname VARCHAR(255) NOT NULL,
    is_active BOOLEAN DEFAULT TRUE,
    probe_mode ENUM('icmp', 'tcp', 'udp') NOT NULL DEFAULT 'icmp',
    probe_port INT NULL,
    probe_tos INT NULL,
    mtr_count SMALLINT NOT NULL DEFAULT 10,
    jitter_threshold_ms DOUBLE NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    INDEX idx_ip_address (ip_address),
    INDEX idx_is_active (is_active),
    INDEX idx_probe_mode (probe_mode)
);

-- Migration-safe updates for existing databases
ALTER TABLE devices ADD COLUMN IF NOT EXISTS probe_mode ENUM('icmp', 'tcp', 'udp') NOT NULL DEFAULT 'icmp';
ALTER TABLE devices ADD COLUMN IF NOT EXISTS probe_port INT NULL;
ALTER TABLE devices ADD COLUMN IF NOT EXISTS probe_tos INT NULL;
ALTER TABLE devices ADD COLUMN IF NOT EXISTS mtr_count SMALLINT NOT NULL DEFAULT 10;
ALTER TABLE devices ADD COLUMN IF NOT EXISTS jitter_threshold_ms DOUBLE NULL;

-- Example data
INSERT INTO devices (ip_address, hostname, is_active) VALUES
('8.8.8.8', 'google-dns', TRUE),
('1.1.1.1', 'cloudflare-dns', TRUE),
('192.168.1.1', 'local-gateway', TRUE)
ON DUPLICATE KEY UPDATE updated_at = CURRENT_TIMESTAMP;

-- Optional: MTR job history table (if you want to track polling runs)
CREATE TABLE IF NOT EXISTS polling_jobs (
    id INT AUTO_INCREMENT PRIMARY KEY,
    started_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    completed_at TIMESTAMP NULL,
    devices_polled INT DEFAULT 0,
    successful_polls INT DEFAULT 0,
    failed_polls INT DEFAULT 0,
    status ENUM('running', 'completed', 'failed') DEFAULT 'running'
);

-- Frontend authentication users
CREATE TABLE IF NOT EXISTS app_users (
    id INT AUTO_INCREMENT PRIMARY KEY,
    username VARCHAR(80) NOT NULL UNIQUE,
    display_name VARCHAR(255) NOT NULL,
    role ENUM('viewer', 'operator', 'admin') NOT NULL,
    password_hash VARCHAR(255) NOT NULL,
    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    INDEX idx_role (role),
    INDEX idx_auth_is_active (is_active)
);
#!/bin/bash

# Configuration
APP_DIR="/root/server"
LOG_DIR="$APP_DIR/log"
APP_NAME="tuf-website"
PID_FILE="$APP_DIR/app.pid"

# Function to log messages
log() {
  echo "[$(date '+%Y-%m-%d %H:%M:%S')] $1"
}

# Function to check system resources
check_system_resources() {
  log "Checking system resources..."
  
  # Check CPU usage
  cpu_usage=$(top -bn1 | grep "Cpu(s)" | awk '{print $2}')
  log "CPU Usage: $cpu_usage%"
  
  # Check memory usage
  memory_usage=$(free -m | awk 'NR==2{printf "%.2f%%", $3*100/$2 }')
  log "Memory Usage: $memory_usage"
  
  # Check disk usage
  disk_usage=$(df -h / | awk 'NR==2{print $5}')
  log "Disk Usage: $disk_usage"
  
  # Check file descriptors
  fd_limit=$(ulimit -n)
  fd_used=$(lsof -n | wc -l)
  log "File Descriptors: $fd_used/$fd_limit"
}

# Function to check database connection
check_database_connection() {
  log "Checking database connection..."
  
  # Try to connect to the database
  if mysql -u root -p -e "SELECT 1;" > /dev/null 2>&1; then
    log "Database connection successful"
  else
    log "Database connection failed"
  fi
}

# Function to check application logs
check_application_logs() {
  log "Checking application logs..."
  
  # Get the most recent log files
  latest_out_log=$(ls -t $LOG_DIR/$APP_NAME.out.*.log | head -1)
  latest_err_log=$(ls -t $LOG_DIR/$APP_NAME.err.*.log | head -1)
  
  # Check for errors in the output log
  log "Checking output log: $latest_out_log"
  error_count=$(grep -i "error\|exception\|warning\|fail" $latest_out_log | wc -l)
  log "Found $error_count potential issues in output log"
  
  # Check for errors in the error log
  log "Checking error log: $latest_err_log"
  error_count=$(grep -i "error\|exception\|warning\|fail" $latest_err_log | wc -l)
  log "Found $error_count potential issues in error log"
  
  # Check for the last 10 lines of each log
  log "Last 10 lines of output log:"
  tail -n 10 $latest_out_log
  
  log "Last 10 lines of error log:"
  tail -n 10 $latest_err_log
}

# Function to check if the application is running
check_application_status() {
  log "Checking application status..."
  
  if [ -f "$PID_FILE" ]; then
    pid=$(cat "$PID_FILE")
    if ps -p $pid > /dev/null; then
      log "Application is running with PID $pid"
      
      # Check process details
      log "Process details:"
      ps -p $pid -o pid,ppid,user,%cpu,%mem,vsz,rss,tty,stat,start,time,command
      
      # Check open files
      log "Open files:"
      lsof -p $pid | head -10
      
      return 0
    else
      log "Application is not running (PID file exists but process is not running)"
      return 1
    fi
  else
    log "Application is not running (PID file does not exist)"
    return 1
  fi
}

# Function to check network connections
check_network_connections() {
  log "Checking network connections..."
  
  # Check listening ports
  log "Listening ports:"
  netstat -tuln | grep LISTEN
  
  # Check established connections
  log "Established connections:"
  netstat -an | grep ESTABLISHED | wc -l
}

# Main diagnostic function
run_diagnostics() {
  log "Starting diagnostics for $APP_NAME..."
  
  # Check system resources
  check_system_resources
  
  # Check database connection
  check_database_connection
  
  # Check application logs
  check_application_logs
  
  # Check application status
  check_application_status
  
  # Check network connections
  check_network_connections
  
  log "Diagnostics complete"
}

# Run the diagnostics
run_diagnostics 
#!/bin/bash

# Configuration
APP_DIR="/root/server"
LOG_DIR="$APP_DIR/log"
APP_NAME="tuf-website"
PID_FILE="$APP_DIR/app.pid"
RESTART_COUNT=0
MAX_RESTARTS=5
RESTART_WINDOW=300  # 5 minutes in seconds
RESTART_TIMES=()

# Function to log messages
log() {
  echo "[$(date '+%Y-%m-%d %H:%M:%S')] $1" | tee -a "$LOG_DIR/monitor.log"
}

# Function to check if the process is running
is_running() {
  if [ -f "$PID_FILE" ]; then
    pid=$(cat "$PID_FILE")
    if ps -p $pid > /dev/null; then
      return 0  # Process is running
    fi
  fi
  return 1  # Process is not running
}

# Function to start the application
start_app() {
  log "Starting $APP_NAME..."
  cd $APP_DIR
  
  # Generate timestamp for log files
  current_time=$(date "+%Y-%m-%d_%H-%M-%S")
  LOG_FILE="$LOG_DIR/$APP_NAME.out.$current_time.log"
  ERROR_LOG_FILE="$LOG_DIR/$APP_NAME.err.$current_time.log"
  
  # Start the application with memory limits
  nohup node --max-old-space-size=512 dist/app.js > $LOG_FILE 2> $ERROR_LOG_FILE &
  pid=$!
  echo $pid > $PID_FILE
  
  # Wait a moment to see if the process is still running
  sleep 5
  if ps -p $pid > /dev/null; then
    log "$APP_NAME started with PID $pid"
    return 0
  else
    log "Failed to start $APP_NAME. Check logs for details."
    return 1
  fi
}

# Function to stop the application
stop_app() {
  if [ -f "$PID_FILE" ]; then
    pid=$(cat "$PID_FILE")
    log "Stopping $APP_NAME (PID: $pid)..."
    kill $pid
    
    # Wait for the process to terminate
    for i in {1..10}; do
      if ! ps -p $pid > /dev/null; then
        log "$APP_NAME stopped successfully"
        rm -f $PID_FILE
        return 0
      fi
      sleep 1
    done
    
    # If the process is still running, force kill it
    log "Force killing $APP_NAME..."
    kill -9 $pid
    rm -f $PID_FILE
    return 0
  else
    log "$APP_NAME is not running"
    return 0
  fi
}

# Function to check restart frequency
check_restart_frequency() {
  current_time=$(date +%s)
  
  # Add current restart time to the array
  RESTART_TIMES+=($current_time)
  
  # Remove restart times older than the window
  while [ ${#RESTART_TIMES[@]} -gt 0 ] && [ $(($current_time - ${RESTART_TIMES[0]})) -gt $RESTART_WINDOW ]; do
    RESTART_TIMES=("${RESTART_TIMES[@]:1}")
  done
  
  # Check if we've restarted too many times in the window
  if [ ${#RESTART_TIMES[@]} -gt $MAX_RESTARTS ]; then
    log "Too many restarts in the last $RESTART_WINDOW seconds. Waiting before trying again."
    sleep 60
    return 1
  fi
  
  return 0
}

# Main monitoring loop
log "Starting monitoring for $APP_NAME"

# Start the application if it's not already running
if ! is_running; then
  start_app
fi

# Monitor the application
while true; do
  if ! is_running; then
    log "$APP_NAME is not running. Attempting to restart..."
    
    # Check restart frequency
    if check_restart_frequency; then
      # Start the application
      if start_app; then
        log "Successfully restarted $APP_NAME"
      else
        log "Failed to restart $APP_NAME"
      fi
    fi
  fi
  
  # Sleep for a short time before checking again
  sleep 10
done 
#!/bin/bash

# Configuration
APP_DIR="/root/server"
LOG_DIR="$APP_DIR/log"
APP_NAME="tuf-website"
current_time=$(date "+%Y-%m-%d_%H-%M-%S")
LOG_FILE="$LOG_DIR/$APP_NAME.out.$current_time.log"
ERROR_LOG_FILE="$LOG_DIR/$APP_NAME.err.$current_time.log"
CURRENT_LOG="$LOG_DIR/current.log"
CURRENT_ERROR_LOG="$LOG_DIR/current_errors.log"

# Create log directory if it doesn't exist
mkdir -p $LOG_DIR

# Function to get the PID of the running process
get_pid() {
    pgrep -f "node.*dist/app.js"
}

# Function to check if the process is running
is_running() {
    pid=$(get_pid)
    if [ -n "$pid" ]; then
        if ps -p $pid > /dev/null; then
            return 0  # Process is running
        fi
    fi
    return 1  # Process is not running
}

# Function to rotate logs
rotate_logs() {
    if [ -f "$CURRENT_LOG" ]; then
        mv "$CURRENT_LOG" "$LOG_FILE"
        echo "Archived current log to $LOG_FILE"
    fi

    if [ -f "$CURRENT_ERROR_LOG" ]; then
        mv "$CURRENT_ERROR_LOG" "$ERROR_LOG_FILE"
        echo "Archived current error log to $ERROR_LOG_FILE"
    fi
}

# Function to start the application
start() {
    if is_running; then
        echo "$APP_NAME is already running with PID $(get_pid)"
        return
    fi

    echo "Starting $APP_NAME..."
    cd $APP_DIR

    # Rotate logs before starting
    rotate_logs

    # Start the application with fixed log filenames
    nohup npm run debug > $CURRENT_LOG 2> $CURRENT_ERROR_LOG &
    pid=$!
    echo "$APP_NAME started with PID $pid"
}

# Function to stop the application
stop() {
    pids=$(get_pid)
    if [ -n "$pids" ]; then
        echo "Stopping $APP_NAME processes..."
        for pid in $pids; do
            echo "Stopping process with PID $pid..."
            kill $pid

            # Wait for the process to terminate
            for i in {1..10}; do
                if ! ps -p $pid > /dev/null; then
                    echo "Process $pid terminated successfully"
                    break
                fi
                sleep 1
            done

            # If the process is still running, force kill it
            if ps -p $pid > /dev/null; then
                echo "Process $pid did not terminate, forcing kill..."
                kill -9 $pid
            fi
        done
        echo "All $APP_NAME processes stopped"
    else
        echo "$APP_NAME is not running"
    fi
}


# Function to restart the application
restart() {
    stop
    sleep 2
    start
}

# Function to check the status of the application
status() {
    if is_running; then
        echo "$APP_NAME is running with PID $(get_pid)"
    else
        echo "$APP_NAME is not running"
    fi
}

# Function to show logs
logs() {
    if [ -f "$CURRENT_LOG" ]; then
        tail -f "$CURRENT_LOG"
    else
        echo "No current log file found"
    fi
}

# Function to show error logs
error_logs() {
    if [ -f "$CURRENT_ERROR_LOG" ]; then
        tail -f "$CURRENT_ERROR_LOG"
    else
        echo "No current error log file found"
    fi
}

# Main script
case "$1" in
    start)
        start
        ;;
    stop)
        stop
        ;;
    restart)
        restart
        ;;
    status)
        status
        ;;
    logs)
        logs
        ;;
    error_logs)
        error_logs
        ;;
    *)
        echo "Usage: $0 {start|stop|restart|status|logs|error_logs}"
        exit 1
        ;;
esac

exit 0
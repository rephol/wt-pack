#!/bin/sh
# Runs inside the image: start herdr headless, start the dashboard, and check what a new user would.
set -u
script -qfc herdr /dev/null >/dev/null 2>&1 &       # herdr wants a terminal; script gives it one
npm --prefix skills/wt-dashboard start >/tmp/server.log 2>&1 &
sleep 8
./setup doctor; echo "doctor exit $? (gh auth is expected to fail)"
for p in health overview; do curl -s -o /dev/null -w "/api/$p %{http_code}\n" "http://127.0.0.1:7777/api/$p"; done

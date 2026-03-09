#!/bin/bash
# DevTools log rotation — keeps disk low, preserves recent testing data
# Runs hourly via cron. Trims JSON logs and truncates text logs.

DATA="/var/www/html/DevTools/data"

# Trim network log to last 200 entries (was 500 in-memory, 200 on disk is fine)
if [ -f "$DATA/network.json" ]; then
  node -e "
    const f='$DATA/network.json';
    try {
      const d=JSON.parse(require('fs').readFileSync(f,'utf8'));
      if(Array.isArray(d)&&d.length>200){
        require('fs').writeFileSync(f,JSON.stringify(d.slice(0,200),null,2));
      }
    } catch(e){}
  " 2>/dev/null
fi

# Trim redirects log to last 100 entries
if [ -f "$DATA/redirects.json" ]; then
  node -e "
    const f='$DATA/redirects.json';
    try {
      const d=JSON.parse(require('fs').readFileSync(f,'utf8'));
      if(Array.isArray(d)&&d.length>100){
        require('fs').writeFileSync(f,JSON.stringify(d.slice(0,100),null,2));
      }
    } catch(e){}
  " 2>/dev/null
fi

# Trim text logs to last 500 lines each
for logfile in "$DATA/weblab.log" "$DATA/weblab-error.log"; do
  if [ -f "$logfile" ]; then
    lines=$(wc -l < "$logfile" 2>/dev/null || echo 0)
    if [ "$lines" -gt 500 ]; then
      tail -500 "$logfile" > "$logfile.tmp" && mv "$logfile.tmp" "$logfile"
    fi
  fi
done

# Trim chat history to last 40 messages (already done by server, safety net)
if [ -f "$DATA/chat-history.json" ]; then
  node -e "
    const f='$DATA/chat-history.json';
    try {
      const d=JSON.parse(require('fs').readFileSync(f,'utf8'));
      if(Array.isArray(d)&&d.length>40){
        require('fs').writeFileSync(f,JSON.stringify(d.slice(-40),null,2));
      }
    } catch(e){}
  " 2>/dev/null
fi

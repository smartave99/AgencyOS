#!/bin/bash
for pid in $(pgrep -x node); do if tr '\0' ' ' < /proc/$pid/cmdline 2>/dev/null | grep -q "fake-launcher-cli"; then kill $pid; fi; done
sleep 1
cd /home/user/AgencyOS
nohup node /tmp/claude-0/-home-user-AgencyOS/becc8a9d-87ff-5e3d-ba68-4cadff714271/scratchpad/fake-launcher-cli.mjs > /tmp/claude-0/-home-user-AgencyOS/becc8a9d-87ff-5e3d-ba68-4cadff714271/scratchpad/fake-launcher.log 2>&1 &
sleep 2
